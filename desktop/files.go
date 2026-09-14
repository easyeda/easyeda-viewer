package main

import (
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// fileEntry is one project file handed to the JS side (see desktopBridge in
// src/ui/dnd.ts): name = basename, rel = path relative to the picked folder
// (becomes webkitRelativePath), b64 = base64-encoded bytes.
type fileEntry struct {
	Name string `json:"name"`
	Rel  string `json:"rel"`
	B64  string `json:"b64"`
}

const maxFileBytes = 64 << 20 // 64 MiB per file is far beyond any .esch2/.epcb2

// readProjectFilesJSON(path) — path may be a single file (.epro2/.esch2/...)
// or a folder (an .eprj3 project directory or a folder containing documents).
// Returns a JSON array; on error returns "[]" so the JS side shows its own
// "unsupported format" message rather than a bridge exception.
func readProjectFilesJSON(path string) string {
	entries, err := readProjectFiles(path)
	if err != nil {
		log.Printf("[files] readProjectFiles(%q): %v", path, err)
		return "[]"
	}
	b, err := json.Marshal(entries)
	if err != nil {
		log.Printf("[files] marshal: %v", err)
		return "[]"
	}
	log.Printf("[files] %q -> %d file(s)", path, len(entries))
	return string(b)
}

func readProjectFiles(path string) ([]fileEntry, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(path)
		return []fileEntry{{Name: name, Rel: name, B64: encode(b)}}, nil
	}

	root := filepath.Clean(path)
	var out []fileEntry
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable corner of the tree: skip, keep going
		}
		if d.IsDir() {
			if skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if info, err := d.Info(); err != nil || info.Size() > maxFileBytes {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			rel = d.Name()
		}
		rel = filepath.ToSlash(rel)
		out = append(out, fileEntry{Name: d.Name(), Rel: rel, B64: encode(b)})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func skipDir(name string) bool {
	// VCS / tooling junk that never belongs to an EasyEDA project
	switch strings.ToLower(name) {
	case "node_modules", "__pycache__", "$recycle.bin":
		return true
	}
	return strings.HasPrefix(name, ".")
}

func encode(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}
