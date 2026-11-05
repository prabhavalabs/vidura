// Package webui embeds the built front-end apps into the binary.
//
// The admin portal's production build (admin/, `bun run build`) is copied
// into ./admin before `go build`. In a fresh checkout the folder holds only a
// placeholder, and /admin explains that the portal hasn't been built.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:admin
var adminFiles embed.FS

// Admin returns the admin portal's files, rooted at its index.html.
func Admin() fs.FS {
	sub, err := fs.Sub(adminFiles, "admin")
	if err != nil {
		panic(err) // the embed directive guarantees the directory exists
	}
	return sub
}
