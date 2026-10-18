package protocol

import (
	"errors"
	"strings"
)

// DeliveryMode fixes whether input starts a later turn or appends to one exact
// active turn. It is included in durable command identity.
type DeliveryMode string

const (
	DeliveryNextTurn DeliveryMode = "next-turn"
	DeliverySteer    DeliveryMode = "steer"
)

// InspectCommandMessage carries the original command payload unchanged except
// for type="inspect_command". It never authorizes replaying the mutation.
type InspectCommandMessage = ControllerCommandMessage

func (c *ControllerCommandMessage) validateDelivery() error {
	if c.DeliveryMode == "" && c.ExpectedTurnID == "" {
		return nil
	}
	if c.Action != ActionSend {
		return errors.New("only send accepts delivery mode")
	}
	switch c.DeliveryMode {
	case "", DeliveryNextTurn:
		if c.ExpectedTurnID != "" {
			return errors.New("expectedTurnId is only valid for steer")
		}
	case DeliverySteer:
		if !ValidTurnID(c.ExpectedTurnID) || strings.HasPrefix(c.SessionID, "terminal:") {
			return errors.New("steer requires an exact native expectedTurnId")
		}
	default:
		return errors.New("unsupported delivery mode")
	}
	return nil
}
