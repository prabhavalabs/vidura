package httpapi

import (
	"bytes"
	"html"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// apiURLPlaceholder in a portal's index.html is replaced with the API origin
// when served, so one build works for every deployment.
const apiURLPlaceholder = "__VIDURA_API_URL__"

// spa serves a single-page app at the root of its host. Real files are
// served as-is (hashed assets are cached for a year); every other path gets
// index.html so client-side routes work on reload.

// Go doesn't know the web app manifest's type; browsers expect it.
func init() { _ = mime.AddExtensionType(".webmanifest", "application/manifest+json") }

func spa(files fs.FS, name, buildHint, apiOrigin string) http.Handler {
	index, err := readIndex(files)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("The " + name + " hasn't been built into this binary. " + buildHint + "\n"))
		})
	}
	index = bytes.ReplaceAll(index, []byte(apiURLPlaceholder), []byte(html.EscapeString(apiOrigin)))
	fileServer := http.FileServerFS(files)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(files, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
			// A missing asset is a real 404, not the app shell.
			if strings.HasPrefix(name, "assets/") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
	})
}

func readIndex(files fs.FS) ([]byte, error) {
	if files == nil {
		return nil, fs.ErrNotExist
	}
	return fs.ReadFile(files, "index.html")
}
