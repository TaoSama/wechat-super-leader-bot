package skills

import "golang.org/x/sys/unix"

func exchangeSkillEntries(first, second string) error {
	return unix.RenamexNp(first, second, unix.RENAME_SWAP)
}
