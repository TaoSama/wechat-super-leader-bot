package appserver

import (
	"encoding/json"
	"fmt"
)

const (
	rpcParseError     = -32700
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
)

type rpcRejectedError struct {
	message         string
	beforeExecution bool
}

func (e *rpcRejectedError) Error() string { return e.message }

func newRPCRejectedError(value any, hasResult bool) *rpcRejectedError {
	encoded, err := json.Marshal(value)
	if err != nil {
		return &rpcRejectedError{message: fmt.Sprintf("codex rpc error: %v", value)}
	}

	rejected := &rpcRejectedError{message: fmt.Sprintf("codex rpc error: %s", encoded)}
	var detail struct {
		Code    *int    `json:"code"`
		Message *string `json:"message"`
	}
	if hasResult || json.Unmarshal(encoded, &detail) != nil || detail.Code == nil || detail.Message == nil {
		return rejected
	}
	// These standard errors reject the request before a method can run. Internal
	// and application errors may follow a mutation, so they remain uncertain.
	switch *detail.Code {
	case rpcParseError, rpcInvalidRequest, rpcMethodNotFound, rpcInvalidParams:
		rejected.beforeExecution = true
	}
	return rejected
}
