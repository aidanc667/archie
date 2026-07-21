package widget

import "testing"

func TestWidget(t *testing.T) {
	if Widget(1) != 1 {
		t.Fail()
	}
}
