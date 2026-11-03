package automation

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Only opt in to a recurrence subset without time expansions. Other native
// schedules remain readable with their original strict lower bound.
func singleDailyHeartbeatRule(rule string) bool {
	seen := map[string]bool{}
	for _, part := range strings.Split(rule, ";") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || seen[key] {
			return false
		}
		seen[key] = true
		if key == "FREQ" {
			if value != "DAILY" {
				return false
			}
			continue
		}
		minimum, maximum := 0, 59
		switch key {
		case "INTERVAL":
			minimum, maximum = 1, int(^uint(0)>>1)
		case "BYHOUR":
			maximum = 23
		case "BYMINUTE", "BYSECOND":
		default:
			return false
		}
		for _, digit := range value {
			if digit < '0' || digit > '9' {
				return false
			}
		}
		number, err := strconv.Atoi(value)
		if err != nil || number < minimum || number > maximum {
			return false
		}
	}
	return seen["FREQ"]
}

func heartbeatEarlyAllowance(ctx context.Context, db *sql.DB, config Config) (time.Duration, error) {
	if config.Kind != "heartbeat" || !singleDailyHeartbeatRule(config.RRule) {
		return 0, nil
	}
	var columns int
	if err := db.QueryRowContext(ctx, "select count(*) from pragma_table_info('automations') where name='rrule'").Scan(&columns); err != nil {
		return 0, fmt.Errorf("read native recurrence schema: %w", err)
	}
	if columns != 1 {
		return 0, nil
	}
	var matches sql.NullBool
	if err := db.QueryRowContext(ctx, "select rrule collate binary = ? from automations where id=?", config.RRule, config.ID).Scan(&matches); err != nil {
		return 0, fmt.Errorf("read native recurrence: %w", err)
	}
	if !matches.Valid || !matches.Bool {
		return 0, nil
	}
	return heartbeatEarlyTolerance, nil
}
