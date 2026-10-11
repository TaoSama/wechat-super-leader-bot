package skills

import (
	"errors"
	"fmt"
	"regexp"
)

const MaxSelectedSkills = 4

type Ref struct {
	ID     string `json:"id"`
	Digest string `json:"digest"`
}

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ValidateRefs validates an ordered selection without sorting or changing it.
func ValidateRefs(refs []Ref) error {
	if len(refs) > MaxSelectedSkills {
		return fmt.Errorf("at most %d selected skills are supported", MaxSelectedSkills)
	}
	seen := make(map[string]bool, len(refs))
	for _, ref := range refs {
		if !digestPattern.MatchString(ref.ID) || !digestPattern.MatchString(ref.Digest) {
			return errors.New("skill id and digest must be lowercase SHA256 identifiers")
		}
		if seen[ref.ID] {
			return errors.New("selected skill IDs must be unique")
		}
		seen[ref.ID] = true
	}
	return nil
}
