// Package pipeline holds the processing steps that turn a YouTube video into
// Sinhala subtitles: caption download, sentence consolidation, quality
// scoring, the translation glossary and the windowed translation itself.
// The worker package runs these steps and records progress.
package pipeline

import (
	"encoding/json"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Segment is one subtitle line, timed in milliseconds.
type Segment struct {
	Index   int    `json:"index"`
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
}

// MaxSegments bounds the final subtitle lines of one video (~8 hours). It is
// applied once, after consolidation, and logged when it bites.
const MaxSegments = 6000

// Consolidation tuning: raw caption cues are 2-4 s fragments that flip too
// fast to read, so they are merged into sentence-level lines.
const (
	mergeMinChars      = 40   // don't close on punctuation before this length
	mergeMaxChars      = 120  // hard break: ~3 lines on a phone
	mergeMaxDurationMs = 9000 // hard break: one line at most ~9 s on screen
	mergeMaxBridgeGap  = 2500 // never merge across real silence
	minDisplayMs       = 1500 // anything shorter flashes by unread
	readingCPS         = 14.0 // characters per second a learner reads
	maxLingerMs        = 1200 // how far past speech a line may stay up
	defaultCueMs       = 4500 // a cue without a duration
)

var (
	sentenceEnd = regexp.MustCompile(`[.!?…][)"'”’]*$`)
	soundTag    = regexp.MustCompile(`^[\[(][^\])]{1,40}[\])]$`)
	whitespace  = regexp.MustCompile(`\s+`)
)

// ParseJSON3 reads YouTube's json3 caption format.
func ParseJSON3(raw []byte) ([]Segment, error) {
	var data struct {
		Events []struct {
			TStartMs    float64 `json:"tStartMs"`
			DDurationMs float64 `json:"dDurationMs"`
			Segs        []struct {
				UTF8 string `json:"utf8"`
			} `json:"segs"`
		} `json:"events"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	out := []Segment{}
	last := ""
	for _, event := range data.Events {
		if event.Segs == nil {
			continue
		}
		var b strings.Builder
		for _, seg := range event.Segs {
			b.WriteString(seg.UTF8)
		}
		text := strings.TrimSpace(whitespace.ReplaceAllString(b.String(), " "))
		// Skip empties and the rolling duplicates of auto captions.
		if text == "" || text == last {
			continue
		}
		last = text
		start := int64(math.Max(0, math.Floor(event.TStartMs)))
		duration := int64(math.Floor(event.DDurationMs))
		if duration <= 0 {
			duration = defaultCueMs
		}
		out = append(out, Segment{Index: len(out), StartMs: start, EndMs: start + duration, Text: text})
	}
	// Auto captions overlap: each rolling cue runs past the next one's start,
	// which makes the player lag. End every cue where the next begins.
	for i := 0; i+1 < len(out); i++ {
		if out[i].EndMs > out[i+1].StartMs {
			out[i].EndMs = max(out[i].StartMs+1, out[i+1].StartMs)
		}
	}
	return out, nil
}

// Consolidate merges caption cues into readable sentence-level lines. A line
// closes when its sentence ends at a readable length, when a hard cap is
// reached, or before a real pause. Each line then stays up long enough to be
// read, without ever running into the next one.
func Consolidate(cues []Segment) []Segment {
	speech := make([]Segment, 0, len(cues))
	for _, cue := range cues {
		text := strings.TrimSpace(cue.Text)
		if text == "" || soundTag.MatchString(text) {
			continue
		}
		cue.Text = text
		speech = append(speech, cue)
	}

	out := []Segment{}
	var current *Segment
	for i, cue := range speech {
		if current != nil && (chars(current.Text)+1+chars(cue.Text) > mergeMaxChars ||
			cue.EndMs-current.StartMs > mergeMaxDurationMs) {
			out = append(out, *current)
			current = nil
		}
		if current == nil {
			c := cue
			current = &c
		} else {
			current.Text += " " + cue.Text
			current.EndMs = cue.EndMs
		}
		gap := int64(math.MaxInt64)
		if i+1 < len(speech) {
			gap = speech[i+1].StartMs - current.EndMs
		}
		done := sentenceEnd.MatchString(current.Text) && chars(current.Text) >= mergeMinChars
		if gap > mergeMaxBridgeGap || done {
			out = append(out, *current)
			current = nil
		}
	}
	if current != nil {
		out = append(out, *current)
	}

	for i := range out {
		next := int64(math.MaxInt64)
		if i+1 < len(out) {
			next = out[i+1].StartMs
		}
		reading := int64(math.Round(float64(chars(out[i].Text)) / readingCPS * 1000))
		desired := max(out[i].StartMs+minDisplayMs, min(out[i].StartMs+reading, out[i].EndMs+maxLingerMs))
		out[i].EndMs = min(next, max(out[i].EndMs, desired))
		if out[i].EndMs <= out[i].StartMs {
			out[i].EndMs = out[i].StartMs + 1
		}
	}

	if len(out) > MaxSegments {
		slog.Warn("transcript truncated", "lines", len(out), "kept", MaxSegments)
		out = out[:MaxSegments]
	}
	for i := range out {
		out[i].Index = i
	}
	return out
}

func chars(text string) int { return utf8.RuneCountInString(text) }
