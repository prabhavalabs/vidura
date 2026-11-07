package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ErrNoCaptions means YouTube has no English caption track for the video.
var ErrNoCaptions = errors.New("the video has no English captions")

// Metadata is what yt-dlp reports about a video. Empty fields are unknown.
type Metadata struct {
	Title        string
	ChannelTitle string
	DurationMs   int64
	ThumbnailURL string
}

// Captions is a downloaded caption track.
type Captions struct {
	Metadata Metadata
	Segments []Segment
	// Track is the caption track used, such as "en" or "en-orig".
	Track string
}

var youtubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// YouTube downloads captions with yt-dlp.
type YouTube struct {
	// Bin is the yt-dlp executable; empty means look it up on PATH.
	Bin string
	// Proxy, when set, is passed to yt-dlp (datacenter IPs are blocked).
	Proxy string
}

// FetchCaptions downloads the original English caption track and the video's
// metadata. It returns ErrNoCaptions (with the metadata) when there is none.
func (y YouTube) FetchCaptions(ctx context.Context, id string) (Captions, error) {
	if !youtubeID.MatchString(id) {
		return Captions{}, fmt.Errorf("invalid YouTube id %q", id)
	}
	bin := y.Bin
	if bin == "" {
		path, err := exec.LookPath("yt-dlp")
		if err != nil {
			return Captions{}, errors.New("yt-dlp isn't installed on the server")
		}
		bin = path
	}
	dir, err := os.MkdirTemp("", "vidura-yt-")
	if err != nil {
		return Captions{}, err
	}
	defer os.RemoveAll(dir)

	// Only the original English track. A wildcard also matches YouTube's
	// dozens of machine-translated variants, which trips its rate limiter.
	args := []string{
		"--skip-download", "--write-subs", "--write-auto-subs",
		"--sub-langs", "en-orig,en,-live_chat", "--sub-format", "json3",
		"--write-info-json", "--no-warnings", "--no-playlist", "--retries", "3",
		"--ignore-config", "-o", filepath.Join(dir, "%(id)s"),
	}
	if y.Proxy != "" {
		args = append(args, "--proxy", y.Proxy)
	}
	args = append(args, "--", "https://www.youtube.com/watch?v="+id)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return Captions{}, fmt.Errorf("yt-dlp: %w", ctx.Err())
	}

	entries, _ := os.ReadDir(dir)
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	meta := readInfo(dir, names, id)

	// yt-dlp can exit non-zero over one track after writing the one we want,
	// so the files decide success, not the exit code.
	track := pick(names)
	if track == "" {
		if runErr != nil {
			return Captions{Metadata: meta}, fmt.Errorf("yt-dlp failed: %s", tail(stderr.String()))
		}
		return Captions{Metadata: meta}, ErrNoCaptions
	}
	raw, err := os.ReadFile(filepath.Join(dir, track))
	if err != nil {
		return Captions{Metadata: meta}, err
	}
	segments, err := ParseJSON3(raw)
	if err != nil {
		return Captions{Metadata: meta}, fmt.Errorf("read captions: %w", err)
	}
	if len(segments) == 0 {
		return Captions{Metadata: meta}, ErrNoCaptions
	}
	lang := strings.TrimSuffix(strings.TrimPrefix(track, id+"."), ".json3")
	return Captions{Metadata: meta, Segments: segments, Track: lang}, nil
}

// pick prefers a manual English track, then the original auto track.
func pick(names []string) string {
	for _, match := range []func(string) bool{
		func(n string) bool { return strings.HasSuffix(n, ".en.json3") },
		func(n string) bool { return strings.HasSuffix(n, ".en-orig.json3") },
		func(n string) bool { return strings.HasSuffix(n, ".json3") },
	} {
		for _, name := range names {
			if match(name) {
				return name
			}
		}
	}
	return ""
}

func readInfo(dir string, names []string, id string) Metadata {
	meta := Metadata{ThumbnailURL: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"}
	for _, name := range names {
		if !strings.HasSuffix(name, ".info.json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return meta
		}
		var info struct {
			Title     string  `json:"title"`
			Uploader  string  `json:"uploader"`
			Channel   string  `json:"channel"`
			Duration  float64 `json:"duration"`
			Thumbnail string  `json:"thumbnail"`
		}
		if json.Unmarshal(raw, &info) != nil {
			return meta
		}
		meta.Title = info.Title
		meta.ChannelTitle = info.Channel
		if meta.ChannelTitle == "" {
			meta.ChannelTitle = info.Uploader
		}
		meta.DurationMs = int64(math.Round(info.Duration * 1000))
		if strings.HasPrefix(info.Thumbnail, "https://i.ytimg.com/") {
			meta.ThumbnailURL = info.Thumbnail
		}
		return meta
	}
	return meta
}

func tail(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > 2 {
		lines = lines[len(lines)-2:]
	}
	out := strings.Join(lines, " ")
	if len(out) > 300 {
		out = out[:300]
	}
	return out
}
