// Two small owner-editable markdown files the agent can also read and update
// itself: memory.md (freeform instructions to remember) and contacts.md
// (who a number/name actually is — client, employee, etc. — since WhatsApp
// itself doesn't tell us that).
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func readNoteFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(b), nil
}

func writeNoteFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// appendMarkdownBullet appends a dated bullet line to path and returns the
// file's new full content.
func appendMarkdownBullet(path, note string) (string, error) {
	existing, err := readNoteFile(path)
	if err != nil {
		return "", err
	}
	line := fmt.Sprintf("- [%s] %s", time.Now().Format("2006-01-02"), strings.TrimSpace(note))
	content := strings.TrimRight(existing, "\n")
	if content == "" {
		content = line
	} else {
		content = content + "\n" + line
	}
	content += "\n"
	if err := writeNoteFile(path, content); err != nil {
		return "", err
	}
	return content, nil
}

// upsertContactNote replaces the existing bullet for `key` (matched
// case-insensitively against "**key**") if one exists, otherwise appends a
// new one. Returns the file's new full content.
func upsertContactNote(path, key, note string) (string, error) {
	existing, err := readNoteFile(path)
	if err != nil {
		return "", err
	}
	key = strings.TrimSpace(key)
	note = strings.TrimSpace(note)
	line := fmt.Sprintf("- **%s**: %s", key, note)

	var lines []string
	if strings.TrimSpace(existing) != "" {
		lines = strings.Split(strings.TrimRight(existing, "\n"), "\n")
	}
	prefix := strings.ToLower("- **" + key + "**")
	replaced := false
	for i, l := range lines {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(l)), prefix) {
			lines[i] = line
			replaced = true
			break
		}
	}
	if !replaced {
		lines = append(lines, line)
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := writeNoteFile(path, content); err != nil {
		return "", err
	}
	return content, nil
}
