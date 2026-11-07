// Package webui embeds the built front-end apps into the binary.
//
// The portals' production builds (admin/ and client/, `bun run build`) are
// copied into ./admin and ./client before `go build`. In a fresh checkout the
// folders hold only a placeholder, and each host explains that its portal
// hasn't been built.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:admin all:client
var files embed.FS

// Admin returns the admin portal's files, rooted at its index.html.
func Admin() fs.FS { return sub("admin") }

// Client returns the client portal's files, rooted at its index.html.
func Client() fs.FS { return sub("client") }

func sub(dir string) fs.FS {
	tree, err := fs.Sub(files, dir)
	if err != nil {
		panic(err) // the embed directive guarantees the directory exists
	}
	return tree
}
