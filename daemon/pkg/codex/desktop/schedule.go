package desktop

import (
	"sort"
	"sync"
)

type desktopDiscoveryTarget struct {
	id    string
	known bool
}

// Each lane advances only after a request is actually sent. Keeping independent
// cursors prevents short watch windows from starving either unseen identities or
// previously observed sessions. No native owner or control authority is cached.
type desktopDiscoverySchedule struct {
	mu       sync.Mutex
	known    map[string]bool
	lastSeen string
	lastNew  string
}

func rotateDesktopIDs(ids []string, after string) []string {
	sort.Strings(ids)
	start := sort.Search(len(ids), func(i int) bool { return ids[i] > after })
	return append(append(make([]string, 0, len(ids)), ids[start:]...), ids[:start]...)
}

func (s *desktopDiscoverySchedule) targets(ids []string) []desktopDiscoveryTarget {
	s.mu.Lock()
	defer s.mu.Unlock()
	known, unseen := []string{}, []string{}
	present := make(map[string]bool, len(ids))
	for _, id := range ids {
		if present[id] {
			continue
		}
		present[id] = true
		if s.known[id] {
			known = append(known, id)
		} else {
			unseen = append(unseen, id)
		}
	}
	for id := range s.known {
		if !present[id] {
			delete(s.known, id)
		}
	}
	known, unseen = rotateDesktopIDs(known, s.lastSeen), rotateDesktopIDs(unseen, s.lastNew)
	targets := make([]desktopDiscoveryTarget, 0, len(present))
	for i := 0; i < len(known) || i < len(unseen); i++ {
		if i < len(known) {
			targets = append(targets, desktopDiscoveryTarget{id: known[i], known: true})
		}
		if i < len(unseen) {
			targets = append(targets, desktopDiscoveryTarget{id: unseen[i]})
		}
	}
	return targets
}

func (s *desktopDiscoverySchedule) dispatched(target desktopDiscoveryTarget) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if target.known {
		s.lastSeen = target.id
	} else {
		s.lastNew = target.id
	}
}

func (s *desktopDiscoverySchedule) observe(id string, available bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !available {
		delete(s.known, id)
		return
	}
	if s.known == nil {
		s.known = make(map[string]bool)
	}
	s.known[id] = true
}
