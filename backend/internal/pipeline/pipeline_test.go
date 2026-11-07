package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
)

func TestParseJSON3DropsRollingDuplicatesAndOverlap(t *testing.T) {
	raw := []byte(`{"events":[
		{"tStartMs":0,"dDurationMs":3000,"segs":[{"utf8":"Hello "},{"utf8":"there."}]},
		{"tStartMs":1000,"dDurationMs":3000,"segs":[{"utf8":"Hello there."}]},
		{"tStartMs":2000,"dDurationMs":3000,"segs":[{"utf8":"Next  line"}]},
		{"tStartMs":9000}
	]}`)
	got, err := ParseJSON3(raw)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "Hello there.", got[0].Text)
	assert.Equal(t, int64(2000), got[0].EndMs, "overlapping cue ends where the next starts")
	assert.Equal(t, "Next line", got[1].Text)
}

func TestConsolidateMergesSentencesAndKeepsSilence(t *testing.T) {
	cues := []Segment{
		{StartMs: 0, EndMs: 1000, Text: "[Music]"},
		{StartMs: 1000, EndMs: 2000, Text: "So today we are going"},
		{StartMs: 2000, EndMs: 3000, Text: "to talk about neurons and how they fire."},
		{StartMs: 3000, EndMs: 4000, Text: "They are"},
		// A long pause: never bridged.
		{StartMs: 10000, EndMs: 11000, Text: "cells."},
	}
	got := Consolidate(cues)
	require.Len(t, got, 3)
	assert.Equal(t, "So today we are going to talk about neurons and how they fire.", got[0].Text)
	assert.Equal(t, int64(1000), got[0].StartMs)
	assert.Equal(t, "They are", got[1].Text)
	assert.LessOrEqual(t, got[1].EndMs, int64(10000), "a line never runs into the next one")
	for i, s := range got {
		assert.Equal(t, i, s.Index)
		assert.Greater(t, s.EndMs, s.StartMs)
	}
}

func TestAssessQuality(t *testing.T) {
	good := []Segment{{StartMs: 0, EndMs: 5000}, {StartMs: 5000, EndMs: 10000}}
	q := AssessQuality(good, 10000, SourceCaptions)
	assert.Equal(t, 100, q.Score)
	assert.Equal(t, "excellent", q.Label)

	short := AssessQuality(good, 40000, SourceCaptions)
	assert.Less(t, short.Score, 100, "a transcript that stops early loses points")
	assert.Equal(t, 0, AssessQuality(nil, 1000, SourceASR).Score)
}

func TestSourceMatches(t *testing.T) {
	assert.True(t, SourceMatches("So today, we're", "So today we're going to talk"))
	assert.False(t, SourceMatches("They are cells", "So today we're going to talk"))
	assert.False(t, SourceMatches("So", "So today"), "too short to prove anything")
}

// fakeModel answers translation windows, misaligning one line on the first
// call so a second round is needed.
type fakeModel struct {
	mu    sync.Mutex
	calls int
	fail  error
}

func (f *fakeModel) Exec(_ context.Context, req chatgpt.Request) (chatgpt.Result, error) {
	f.mu.Lock()
	f.calls++
	call := f.calls
	f.mu.Unlock()
	if f.fail != nil {
		return chatgpt.Result{}, f.fail
	}
	var in struct {
		TranslateIndices []int `json:"translateIndices"`
		Transcript       []struct {
			Index int    `json:"index"`
			Text  string `json:"text"`
		} `json:"transcript"`
	}
	if err := json.Unmarshal([]byte(req.Input), &in); err != nil {
		return chatgpt.Result{}, err
	}
	if in.TranslateIndices == nil { // glossary request
		return chatgpt.Result{Text: `{"topic":"Neurons","summary":"How neurons talk","audience":"learners","translationGuidelines":"plain","keyTerms":[]}`}, nil
	}
	text := map[int]string{}
	for _, line := range in.Transcript {
		text[line.Index] = line.Text
	}
	type item struct {
		Index int    `json:"index"`
		Src   string `json:"src"`
		Text  string `json:"text"`
	}
	out := []item{}
	for i, index := range in.TranslateIndices {
		src := text[index]
		if call == 1 && i == 0 {
			src = "something else entirely"
		}
		out = append(out, item{Index: index, Src: src, Text: "si:" + text[index]})
	}
	data, _ := json.Marshal(map[string]any{"translations": out})
	return chatgpt.Result{Text: string(data)}, nil
}

func lines(n int) []Segment {
	out := make([]Segment, n)
	for i := range out {
		out[i] = Segment{Index: i, StartMs: int64(i) * 1000, EndMs: int64(i)*1000 + 900,
			Text: "Line number " + strings.Repeat("x", i%5) + string(rune('a'+i%26)) + " says something"}
	}
	return out
}

func TestTranslateWindowsRetriesMisalignedAndSaves(t *testing.T) {
	model := &fakeModel{}
	segments := lines(LinesPerCall + 5)
	saved := 0
	got, err := Translate(context.Background(), model, Task{Model: "m"}, TranslateInput{
		Segments: segments,
		Done:     map[int]string{3: "kept"},
		Saved: func(l []Line, done, total int) error {
			saved += len(l)
			assert.Equal(t, len(segments), total)
			return nil
		},
	})
	require.NoError(t, err)
	assert.Len(t, got, len(segments))
	assert.Equal(t, "kept", got[3], "earlier work is not redone")
	assert.Equal(t, len(segments)-1, saved)
	assert.Equal(t, "si:"+segments[0].Text, got[0])
	assert.Equal(t, 3, model.calls, "two windows, then one retry for the misaligned line")
}

func TestTranslateStopsOnQuota(t *testing.T) {
	model := &fakeModel{fail: chatgpt.ErrQuota}
	_, err := Translate(context.Background(), model, Task{Model: "m"}, TranslateInput{Segments: lines(3)})
	require.True(t, errors.Is(err, chatgpt.ErrQuota))
	assert.Equal(t, 1, model.calls)
}

func TestBuildContext(t *testing.T) {
	got, err := BuildContext(context.Background(), &fakeModel{}, Task{Model: "m"}, VideoInfo{Title: "t"}, lines(2))
	require.NoError(t, err)
	assert.Equal(t, "Neurons", got.Topic)
}
