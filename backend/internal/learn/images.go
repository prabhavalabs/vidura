package learn

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image/jpeg"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Picture is a generated illustration of an idea from a video.
type Picture struct {
	ID      string `json:"id"`
	Concept string `json:"concept"`
	Caption string `json:"caption,omitempty"`
	Locale  string `json:"locale"`
	// Status is "pending", "ready" or "failed".
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
	// URL is a signed address of the picture, valid for an hour.
	URL string `json:"url,omitempty"`
}

// MaxConcept is the longest idea that can be asked for, in characters.
const MaxConcept = 300

// imageURLTTL is how long a picture's signed address works.
const imageURLTTL = time.Hour

// Signer makes and checks the signed picture addresses.
type Signer struct {
	Secret []byte
	// Base is the API's origin, e.g. https://api-vidura.prabhavalabs.com.
	Base string
	now  func() time.Time
}

func (g Signer) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

func (g Signer) mac(id string, expires int64) string {
	h := hmac.New(sha256.New, g.Secret)
	fmt.Fprintf(h, "vidura-image:%s:%d", id, expires)
	return hex.EncodeToString(h.Sum(nil))
}

// URL is the picture's address, valid for imageURLTTL.
func (g Signer) URL(id string) string {
	expires := g.clock().Add(imageURLTTL).Truncate(time.Minute).Unix()
	return fmt.Sprintf("%s/media/images/%s?e=%d&s=%s", g.Base, id, expires, g.mac(id, expires))
}

// Valid checks a picture address's expiry and signature.
func (g Signer) Valid(id, expires, signature string) bool {
	e, err := strconv.ParseInt(expires, 10, 64)
	if err != nil || g.clock().Unix() > e {
		return false
	}
	return hmac.Equal([]byte(signature), []byte(g.mac(id, e)))
}

// Pictures lists the illustrations made for one of ownerID's videos, newest
// first, with signed addresses.
func (s *Service) Pictures(ctx context.Context, ownerID, videoID string, sign Signer) ([]Picture, error) {
	if err := s.ownsVideo(ctx, ownerID, videoID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, concept, coalesce(caption, ''), locale, status,
		coalesce(error_message, ''), created_at FROM concept_images
		WHERE video_id = ? AND owner_id = ? ORDER BY created_at DESC`, videoID, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pictures := []Picture{}
	for rows.Next() {
		var p Picture
		if err := rows.Scan(&p.ID, &p.Concept, &p.Caption, &p.Locale, &p.Status, &p.Error, &p.CreatedAt); err != nil {
			return nil, err
		}
		if p.Status == "ready" {
			p.URL = sign.URL(p.ID)
		}
		pictures = append(pictures, p)
	}
	return pictures, rows.Err()
}

// Illustrate starts making a picture that explains concept (or, when it's
// empty, the video's main idea) and returns it as pending.
func (s *Service) Illustrate(ctx context.Context, ownerID, videoID, concept, locale string) (Picture, error) {
	concept = strings.TrimSpace(concept)
	if utf8.RuneCountInString(concept) > MaxConcept {
		return Picture{}, fmt.Errorf("describe the idea in up to %d characters", MaxConcept)
	}
	if !Locales[locale] {
		return Picture{}, ErrBadLocale
	}
	if _, err := s.task(ctx, "summary"); err != nil {
		return Picture{}, err
	}
	if n, err := s.pendingCount(ctx, ownerID); err != nil {
		return Picture{}, err
	} else if n >= maxPending {
		return Picture{}, ErrBusy
	}
	v, err := s.loadVideo(ctx, ownerID, videoID)
	if err != nil {
		return Picture{}, err
	}
	p := Picture{ID: uuid.NewString(), Concept: concept, Locale: locale, Status: "pending", CreatedAt: db.FormatTime(s.now())}
	if p.Concept == "" {
		p.Concept = v.Title
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO concept_images (id, video_id, owner_id, concept, locale, status,
		created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
		p.ID, videoID, ownerID, p.Concept, locale, p.CreatedAt, p.CreatedAt); err != nil {
		return Picture{}, err
	}
	s.background(func() { s.makePicture(v, p) })
	return p, nil
}

func (s *Service) makePicture(v video, p Picture) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	file, caption, err := s.drawPicture(ctx, v, p)
	now := db.FormatTime(s.now())
	if err != nil {
		slog.Warn("learn: picture failed", "video", v.ID, "err", err)
		_, _ = s.db.ExecContext(ctx, `UPDATE concept_images SET status = 'failed', error_message = ?, updated_at = ?
			WHERE id = ?`, friendly(err), now, p.ID)
		s.learnFinished(v, "picture", false)
		return
	}
	res, err := s.db.ExecContext(ctx, `UPDATE concept_images SET status = 'ready', file = ?, caption = ?,
		error_message = NULL, updated_at = ? WHERE id = ?`, file, caption, now, p.ID)
	if err != nil {
		_ = os.Remove(filepath.Join(s.imagesDir, file))
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// The video (or picture) was deleted meanwhile.
		_ = os.Remove(filepath.Join(s.imagesDir, file))
		return
	}
	s.learnFinished(v, "picture", true)
}

func (s *Service) drawPicture(ctx context.Context, v video, p Picture) (string, string, error) {
	task, err := s.task(ctx, "summary")
	if err != nil {
		return "", "", err
	}
	captionLang := "English"
	if p.Locale == "si" {
		captionLang = "Sinhala (සිංහල)"
	}
	system := "You make educational illustrations for a learner. Use your image generation tool exactly once " +
		"to create one clear, friendly picture that explains the idea below, the way a good teacher would draw " +
		"it: a simple diagram or scene, flat style, soft colours, white background. Do not put any words, letters " +
		"or numbers in the picture. Then reply with one short sentence in " + captionLang +
		" that says what the picture shows; reply with nothing else."
	input := fmt.Sprintf("Idea to illustrate: %s\nFrom the video: %s\n", p.Concept, v.Title)
	if summary, err := s.readInsight(ctx, v.ID, "summary", p.Locale); err == nil && summary.Status == "ready" {
		input += "Study summary of the video (for context):\n" + string(summary.Content) + "\n"
	} else if v.Context != nil && v.Context.Summary != "" {
		input += "About the video: " + v.Context.Summary + "\n"
	}
	result, err := s.ai.Exec(ctx, chatgpt.Request{
		System: system, Input: input, Model: task.Model, Effort: "low",
		Images: true, Lane: chatgpt.LaneStudy, Timeout: 6 * time.Minute,
	})
	for i, path := range result.Images {
		if i == 0 {
			continue
		}
		_ = os.Remove(path)
	}
	if len(result.Images) > 0 {
		defer os.RemoveAll(filepath.Dir(result.Images[0]))
	}
	if err != nil {
		return "", "", err
	}
	if len(result.Images) == 0 {
		return "", "", errors.New("no picture was made; please try again")
	}
	if err := os.MkdirAll(filepath.Join(s.imagesDir, v.ID), 0o700); err != nil {
		return "", "", err
	}
	file, err := savePicture(result.Images[0], filepath.Join(s.imagesDir, v.ID), p.ID)
	if err != nil {
		return "", "", err
	}
	caption := strings.TrimSpace(result.Text)
	if utf8.RuneCountInString(caption) > 400 {
		caption = string([]rune(caption)[:400])
	}
	return file, caption, nil
}

// savePicture stores a generated PNG in dir as a JPEG (a tenth of the size,
// for phones; the pictures have plain backgrounds), or as the PNG it is if
// it can't be read. It returns the file's path relative to the images folder.
func savePicture(from, dir, id string) (string, error) {
	if source, err := os.Open(from); err == nil {
		img, decodeErr := png.Decode(source)
		source.Close()
		if decodeErr == nil {
			target := filepath.Join(dir, id+".jpg")
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return "", err
			}
			if err := jpeg.Encode(out, img, &jpeg.Options{Quality: 85}); err != nil {
				out.Close()
				return "", err
			}
			if err := out.Close(); err != nil {
				return "", err
			}
			_ = os.Remove(from)
			return filepath.Join(filepath.Base(dir), id+".jpg"), nil
		}
	}
	if err := moveFile(from, filepath.Join(dir, id+".png")); err != nil {
		return "", err
	}
	return filepath.Join(filepath.Base(dir), id+".png"), nil
}

// moveFile renames, or copies when the two paths are on different disks.
func moveFile(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	if err := os.WriteFile(to, data, 0o600); err != nil {
		return err
	}
	return os.Remove(from)
}

// PictureFile returns the path of a ready picture, for a signed request.
func (s *Service) PictureFile(ctx context.Context, id string) (string, error) {
	var file sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT file FROM concept_images WHERE id = ? AND status = 'ready'`, id).Scan(&file)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !file.Valid) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	path := filepath.Join(s.imagesDir, filepath.Clean(file.String))
	if !strings.HasPrefix(path, filepath.Clean(s.imagesDir)+string(filepath.Separator)) {
		return "", ErrNotFound
	}
	return path, nil
}

// DeletePicture removes one of ownerID's pictures.
func (s *Service) DeletePicture(ctx context.Context, ownerID, id string) error {
	var file sql.NullString
	err := s.db.QueryRowContext(ctx, `DELETE FROM concept_images WHERE id = ? AND owner_id = ? RETURNING file`,
		id, ownerID).Scan(&file)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if file.Valid {
		_ = os.Remove(filepath.Join(s.imagesDir, filepath.Clean(file.String)))
	}
	return nil
}

// ForgetVideo removes a deleted video's pictures from disk (its rows went
// with the video).
func (s *Service) ForgetVideo(videoID string) {
	if videoID == "" || strings.ContainsAny(videoID, `/\.`) {
		return
	}
	_ = os.RemoveAll(filepath.Join(s.imagesDir, videoID))
}
