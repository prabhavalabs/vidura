package catalog

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseYouTubeID(t *testing.T) {
	const id = "dQw4w9WgXcQ"
	for _, link := range []string{
		id,
		"https://www.youtube.com/watch?v=" + id,
		"https://www.youtube.com/watch?feature=share&v=" + id + "&t=42s",
		"youtube.com/watch?v=" + id,
		"https://m.youtube.com/watch?v=" + id,
		"https://music.youtube.com/watch?v=" + id + "&list=x",
		"https://youtu.be/" + id,
		"https://youtu.be/" + id + "?si=abc&t=3",
		"https://www.youtube.com/shorts/" + id,
		"https://www.youtube.com/embed/" + id + "?start=5",
		"https://www.youtube.com/live/" + id + "?feature=share",
		"https://www.youtube-nocookie.com/embed/" + id,
		"  https://youtu.be/" + id + "  ",
	} {
		got, err := ParseYouTubeID(link)
		assert.NoError(t, err, link)
		assert.Equal(t, id, got, link)
	}
	for _, link := range []string{
		"", "hello", "https://vimeo.com/123456789", "https://www.youtube.com/watch?v=short",
		"https://www.youtube.com/channel/UCabcdefghijk", "https://evil.example/watch?v=" + id,
		"javascript:alert(1)", "https://youtu.be/" + id + "x",
	} {
		_, err := ParseYouTubeID(link)
		assert.ErrorIs(t, err, ErrBadURL, link)
	}
}
