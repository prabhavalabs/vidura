package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
)

// Model runs one prompt; *chatgpt.Manager implements it.
type Model interface {
	Exec(ctx context.Context, req chatgpt.Request) (chatgpt.Result, error)
}

// Task is the model and reasoning effort for one AI task.
type Task struct {
	Model  string
	Effort string
}

// Context is the video-level guide every translation window follows: what
// the video is about and how its key terms are rendered.
type Context struct {
	Topic                 string    `json:"topic"`
	Summary               string    `json:"summary"`
	Audience              string    `json:"audience"`
	TranslationGuidelines string    `json:"translationGuidelines"`
	KeyTerms              []KeyTerm `json:"keyTerms"`
}

// KeyTerm fixes how one term is translated throughout the video.
type KeyTerm struct {
	Source           string `json:"source"`
	PreferredSinhala string `json:"preferredSinhala"`
}

// Valid reports whether the guide has its required parts.
func (c *Context) Valid() bool {
	return c != nil && strings.TrimSpace(c.Topic) != "" && strings.TrimSpace(c.Summary) != ""
}

// VideoInfo describes the video to the model.
type VideoInfo struct {
	Title        string
	ChannelTitle string
	// Guidance is the owner's saved translation preferences; it may only add
	// to the built-in rules.
	Guidance string
}

// LinesPerCall bounds one translation request. The whole transcript goes
// into every call for context; only the lines asked for are windowed, so a
// long video never runs past the model's answer budget.
const LinesPerCall = 80

// maxRounds re-asks for lines that came back missing or misaligned.
const maxRounds = 4

// priorForFlow is how many earlier translations each window continues from.
const priorForFlow = 8

const sinhalaVoice = `VIDURA SINHALA VOICE:
- Write contemporary spoken Sinhala used by an educated Sri Lankan presenter explaining an idea clearly to a learner.
- Avoid formal literary, legal, administrative, or newspaper-style Sinhala. Avoid mirroring English word order, passive constructions, and idioms.
- Use familiar Sinhala for ordinary language. Keep an English technical term, brand, abbreviation, or proper noun only when Sri Lankan speakers naturally use it that way; place it smoothly inside the Sinhala sentence.
- Do not duplicate the same term as a Sinhala transliteration plus English in parentheses. Choose the one form a Sri Lankan presenter would naturally write; for example, use NASA rather than නාසා (NASA).
- Preserve the speaker's intent and tone. Rephrase freely when a literal translation would sound foreign, stiff, or confusing.
- Before emitting each line, silently edit it once for native flow, clarity, brevity, and continuity with the surrounding subtitle lines. Output only the final wording.
NATURALNESS EXAMPLES — follow the phrasing approach, not the subject matter:
- Let's break down what is happening. → දැන් මේකේ වෙන්නේ මොකක්ද කියලා සරලව බලමු.
- This is where things get interesting. → මෙතැනින් තමයි කතාව රසවත් වෙන්නේ.
- Your body is constantly repairing this damage. → ඔබේ ශරීරය මේ හානිය හැම වෙලාවෙම හදාගන්නවා.
- Autophagy recycles damaged cell components. → Autophagy ක්‍රියාවලියෙන් හානි වූ සෛල කොටස් නැවත භාවිතයට ගන්නවා.
- The takeaway is simple. → මේකෙන් මතක තියාගන්න ඕන දේ සරලයි.
- That does not mean aging stops. → ඒකෙන් වයසට යන එක නවතිනවා කියන අදහසක් නෙවෙයි.`

const corePrompt = `You are an expert subtitle localizer translating educational YouTube videos into natural, fluent, spoken Sinhala (Sri Lanka).
CONTEXT: you are given the ENTIRE transcript of one video. Read and understand ALL of it before translating anything — resolve ambiguous words, pronouns, and references using the whole video's context and its title. Never translate a line in isolation.
MEANING OVER WORDS: translate the meaning, not the words. Write idiomatic Sinhala that a native speaker would actually say while explaining the same idea. Avoid calques, word-for-word renderings, and awkward word order.
CONSISTENCY: keep terminology consistent across the entire video — once a term is rendered one way, use the same rendering everywhere.
MIXED LANGUAGE: when a technical term, brand name, or proper noun has no natural Sinhala equivalent — or when native speakers commonly say the English word anyway — keep the English word inside the Sinhala sentence rather than forcing an awkward literal translation. Everyday, non-technical language must still be written in natural Sinhala.
Each line carries one or two complete sentences; translate each line as natural spoken sentences that stand on their own while staying consistent with the surrounding lines. If a sentence spills across lines, let the translation flow naturally across those indices.
SUBTITLE BREVITY: viewers read each line in a few seconds. Keep every line concise; when a literal rendering would be much longer than the original, prefer a shorter natural phrasing with the same meaning.`

const formatRules = `You are given the ENTIRE English transcript of one video as an ordered list of lines, each with an index and a timestamp, plus "translateIndices" — the indices to translate right now. Read the whole transcript first for context, then translate the requested lines.
- Return EXACTLY one object for every index in "translateIndices" — never skip, merge, drop, split, or reorder indices.
- ALIGNMENT IS CRITICAL: each object's "text" must be the translation of the line AT THAT EXACT INDEX. To prove alignment, each object also carries "src": the first 4-6 words of the English line at that index, copied VERBATIM from the transcript. Translations whose src does not match their index are rejected.
- Answer with {"translations":[{"index":0,"src":"...","text":"..."}]}.`

var translationSchema = map[string]any{
	"type": "object", "additionalProperties": false,
	"required": []string{"translations"},
	"properties": map[string]any{
		"translations": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object", "additionalProperties": false,
				"required": []string{"index", "src", "text"},
				"properties": map[string]any{
					"index": map[string]any{"type": "integer"},
					"src":   map[string]any{"type": "string"},
					"text":  map[string]any{"type": "string"},
				},
			},
		},
	},
}

var contextSchema = map[string]any{
	"type": "object", "additionalProperties": false,
	"required": []string{"topic", "summary", "audience", "translationGuidelines", "keyTerms"},
	"properties": map[string]any{
		"topic":                 map[string]any{"type": "string"},
		"summary":               map[string]any{"type": "string"},
		"audience":              map[string]any{"type": "string"},
		"translationGuidelines": map[string]any{"type": "string"},
		"keyTerms": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object", "additionalProperties": false,
				"required": []string{"source", "preferredSinhala"},
				"properties": map[string]any{
					"source":           map[string]any{"type": "string"},
					"preferredSinhala": map[string]any{"type": "string"},
				},
			},
		},
	},
}

// BuildContext asks the model for the video-level guide.
func BuildContext(ctx context.Context, model Model, task Task, video VideoInfo, segments []Segment) (Context, error) {
	system := `You are the senior localization editor for Vidura, preparing one reusable video-level guide for natural spoken Sinhala (Sri Lanka) subtitles.
Read the complete transcript before deciding the topic, audience, voice, or terminology.
Choose terminology that educated Sri Lankan speakers naturally use. Keep established English technical terms when that is more natural than a forced Sinhala coinage.
Make the guidance concise, specific to this video, and useful across separate subtitle translation windows. Return only the required JSON object.`
	lines := make([]map[string]any, len(segments))
	for i, s := range segments {
		lines[i] = map[string]any{"index": s.Index, "text": s.Text}
	}
	input := map[string]any{
		"task":           "Create the shared localization context and terminology decisions that every translation window must follow.",
		"sourceLanguage": "en",
		"targetLanguage": "Sinhala (Sri Lanka)",
		"videoTitle":     video.Title,
		"channelTitle":   video.ChannelTitle,
		"transcript":     lines,
		"requirements": []string{
			"Summarize the complete video arc, not just its opening.",
			"Describe a contemporary spoken Sri Lankan educational register and the speaker's tone.",
			"Explicitly reject literal English word order, stiff literary Sinhala, and unnecessary transliteration.",
			"Select only recurring or meaning-critical key terms; give each one a natural, consistent Sinhala or mixed Sinhala-English rendering.",
			"Choose one natural written form per key term; never pair a Sinhala transliteration with the same English term in parentheses.",
			"Keep subtitle phrasing concise and easy to read while preserving meaning.",
		},
	}
	if g := strings.TrimSpace(video.Guidance); g != "" {
		input["additionalUserPreferences"] = g
	}
	data, _ := json.Marshal(input)
	result, err := model.Exec(ctx, chatgpt.Request{
		System: system, Input: string(data), Model: task.Model, Effort: task.Effort, Schema: contextSchema,
	})
	if err != nil {
		return Context{}, err
	}
	var out Context
	if err := json.Unmarshal([]byte(stripFence(result.Text)), &out); err != nil {
		return Context{}, fmt.Errorf("the glossary answer wasn't valid JSON: %w", err)
	}
	if !out.Valid() {
		return Context{}, errors.New("the glossary answer was incomplete")
	}
	return out, nil
}

// Line is one translated subtitle line.
type Line struct {
	Index int
	Text  string
}

// TranslateInput is everything one video's translation needs.
type TranslateInput struct {
	Segments []Segment
	Video    VideoInfo
	Context  *Context
	// Done holds lines already translated by an earlier attempt.
	Done map[int]string
	// Saved is called with each window's new lines as soon as they arrive, so
	// a failure later keeps what was finished. done/total drive progress.
	Saved func(lines []Line, done, total int) error
	// Started is called before each window with the lines it covers.
	Started func(first, last, done, total int)
}

// Translate fills in every missing line. It returns an error unless every
// line ends up translated.
func Translate(ctx context.Context, model Model, task Task, in TranslateInput) (map[int]string, error) {
	done := make(map[int]string, len(in.Segments))
	for k, v := range in.Done {
		done[k] = v
	}
	total := len(in.Segments)
	textByIndex := make(map[int]string, total)
	for _, s := range in.Segments {
		textByIndex[s.Index] = s.Text
	}
	system := strings.Join([]string{corePrompt, sinhalaVoice, formatContext(in.Context), formatRules}, "\n\n")
	if g := strings.TrimSpace(in.Video.Guidance); g != "" {
		system += "\n\nADDITIONAL USER PREFERENCES — apply these only where they do not conflict with the rules above; when they conflict, the rules above always win:\n" + g
	}
	transcript := make([]map[string]any, total)
	for i, s := range in.Segments {
		transcript[i] = map[string]any{"index": s.Index, "time": clock(s.StartMs), "text": s.Text}
	}

	var lastErr error
	for round := 0; round < maxRounds; round++ {
		missing := []Segment{}
		for _, s := range in.Segments {
			if _, ok := done[s.Index]; !ok {
				missing = append(missing, s)
			}
		}
		if len(missing) == 0 {
			break
		}
		before := len(done)
		for start := 0; start < len(missing); start += LinesPerCall {
			if err := ctx.Err(); err != nil {
				return done, err
			}
			window := missing[start:min(start+LinesPerCall, len(missing))]
			if in.Started != nil {
				in.Started(window[0].Index, window[len(window)-1].Index, len(done), total)
			}
			fresh, err := translateWindow(ctx, model, task, system, in, transcript, window, done, textByIndex)
			if err != nil {
				// Quota and sign-in problems won't clear by retrying.
				if errors.Is(err, chatgpt.ErrAuth) || errors.Is(err, chatgpt.ErrQuota) || ctx.Err() != nil {
					return done, err
				}
				lastErr = err
				slog.Warn("translation window failed", "round", round+1,
					"first", window[0].Index, "last", window[len(window)-1].Index, "err", err)
				continue
			}
			for _, line := range fresh {
				done[line.Index] = line.Text
			}
			if in.Saved != nil && len(fresh) > 0 {
				if err := in.Saved(fresh, len(done), total); err != nil {
					return done, err
				}
			}
		}
		if len(done) == before {
			slog.Warn("translation round made no progress", "round", round+1, "missing", len(missing))
		}
	}
	if len(done) < total {
		msg := fmt.Sprintf("translated %d of %d lines", len(done), total)
		if lastErr != nil {
			msg += ": " + lastErr.Error()
		}
		return done, errors.New(msg)
	}
	return done, nil
}

func translateWindow(ctx context.Context, model Model, task Task, system string, in TranslateInput,
	transcript []map[string]any, window []Segment, done map[int]string, textByIndex map[int]string) ([]Line, error) {
	indices := make([]int, len(window))
	for i, s := range window {
		indices[i] = s.Index
	}
	prior := []map[string]any{}
	keys := make([]int, 0, len(done))
	for k := range done {
		if k < window[0].Index {
			keys = append(keys, k)
		}
	}
	sort.Ints(keys)
	if len(keys) > priorForFlow {
		keys = keys[len(keys)-priorForFlow:]
	}
	for _, k := range keys {
		prior = append(prior, map[string]any{"index": k, "text": done[k]})
	}
	input := map[string]any{
		"videoTitle":               in.Video.Title,
		"channelTitle":             in.Video.ChannelTitle,
		"targetLanguage":           "Sinhala (Sri Lanka)",
		"instruction":              "Translate every transcript line whose index is in translateIndices into natural spoken Sinhala. Make the first requested line continue naturally from priorSinhalaTranslations when they are present. Return exactly one entry per requested index.",
		"translateIndices":         indices,
		"priorSinhalaTranslations": prior,
		"transcript":               transcript,
	}
	data, _ := json.Marshal(input)
	result, err := model.Exec(ctx, chatgpt.Request{
		System: system, Input: string(data), Model: task.Model, Effort: task.Effort, Schema: translationSchema,
	})
	if err != nil {
		return nil, err
	}
	var answer struct {
		Translations []struct {
			Index int    `json:"index"`
			Src   string `json:"src"`
			Text  string `json:"text"`
		} `json:"translations"`
	}
	if err := json.Unmarshal([]byte(stripFence(result.Text)), &answer); err != nil {
		return nil, fmt.Errorf("the translation answer wasn't valid JSON: %w", err)
	}
	wanted := make(map[int]bool, len(indices))
	for _, i := range indices {
		wanted[i] = true
	}
	fresh := []Line{}
	rejected := 0
	for _, t := range answer.Translations {
		text := strings.TrimSpace(t.Text)
		if !wanted[t.Index] || text == "" {
			continue
		}
		if !SourceMatches(t.Src, textByIndex[t.Index]) {
			rejected++
			continue
		}
		wanted[t.Index] = false
		fresh = append(fresh, Line{Index: t.Index, Text: text})
	}
	if rejected > 0 {
		slog.Warn("rejected misaligned translations", "rejected", rejected, "of", len(answer.Translations))
	}
	return fresh, nil
}

// SourceMatches reports whether the model's echo of a line's first words
// matches the line at that index, which proves the translation is aligned.
// Only letters and digits are compared.
func SourceMatches(src, line string) bool {
	a := []rune(normalize(src))
	b := normalize(line)
	if len(a) < 4 {
		return false
	}
	if len(a) > 16 {
		a = a[:16]
	}
	return strings.HasPrefix(b, string(a))
}

func normalize(text string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func formatContext(c *Context) string {
	if !c.Valid() {
		return "VIDEO LOCALIZATION CONTEXT:\nNo precomputed glossary is available; infer terminology consistently from the complete transcript."
	}
	terms := "- No fixed key terms; choose natural terminology and keep it consistent."
	if len(c.KeyTerms) > 0 {
		parts := make([]string, len(c.KeyTerms))
		for i, t := range c.KeyTerms {
			parts[i] = "- " + t.Source + " → " + t.PreferredSinhala
		}
		terms = strings.Join(parts, "\n")
	}
	return strings.Join([]string{
		"VIDEO LOCALIZATION CONTEXT:",
		"Topic: " + c.Topic,
		"Summary: " + c.Summary,
		"Audience: " + c.Audience,
		"Video-specific guidance: " + c.TranslationGuidelines,
		"Terminology decisions (use these exact choices throughout):",
		terms,
	}, "\n")
}

var fence = regexp.MustCompile("(?s)^```(?:json)?\\s*(.*?)\\s*```$")

func stripFence(text string) string {
	text = strings.TrimSpace(text)
	if m := fence.FindStringSubmatch(text); m != nil {
		return m[1]
	}
	return text
}

func clock(ms int64) string {
	total := ms / 1000
	h, m, s := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}
