//go:build !darwin && !linux

package skills

import (
	"errors"
	"os"
)

func openSkillRoot(name string) (*os.Root, error) {
	return nil, errors.New("skill catalog platform unsupported")
}

func openSkillFile(root *os.Root, name string, directory bool) (*os.File, os.FileInfo, error) {
	return nil, nil, errors.New("skill catalog platform unsupported")
}
