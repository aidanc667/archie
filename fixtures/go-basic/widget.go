package widget

import (
	"fmt"

	"github.com/acme/widget/helper"
)

// Widget is exported (capitalized), so it should be reported as such.
func Widget(x int) int {
	if x > 0 {
		return helper.Assist(x)
	} else if x < 0 {
		return -1
	}
	for i := 0; i < x; i++ {
		if i == 5 {
			continue
		}
	}
	switch x {
	case 1:
		fmt.Println("one")
	default:
		fmt.Println("other")
	}
	return 0
}

// unexportedHelper is lowercase, so it should be reported as not exported.
func unexportedHelper() int {
	return 1
}

type Runner struct{}

// Run is a method with a receiver; methods are always treated as not
// exported regardless of capitalization (a deliberate v1 simplification).
func (r Runner) Run() int {
	return unexportedHelper()
}
