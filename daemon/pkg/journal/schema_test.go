package journal

import (
	"os"
	"path/filepath"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func TestExistingJournalMustNotBeReinitialized(t *testing.T) {
	for _, fixture := range []string{"empty-file", "missing-schema", "missing-scope"} {
		t.Run(fixture, func(t *testing.T) {
			dir := testPrivateDir(t)
			path := filepath.Join(dir, FileName)
			if fixture == "empty-file" {
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				db, err := bolt.Open(path, 0600, nil)
				if err != nil {
					t.Fatal(err)
				}
				if fixture == "missing-scope" {
					err = db.Update(func(tx *bolt.Tx) error {
						for _, name := range [][]byte{metaBucket, recordsBucket, pendingBucket} {
							if _, err := tx.CreateBucket(name); err != nil {
								return err
							}
						}
						return nil
					})
				}
				closeErr := db.Close()
				if err != nil {
					t.Fatal(err)
				}
				if closeErr != nil {
					t.Fatal(closeErr)
				}
			}
			j, err := Open(dir, "test-scope")
			if err == nil {
				closeJournal(t, j)
				t.Fatal("existing invalid journal was silently reinitialized")
			}
		})
	}
}
