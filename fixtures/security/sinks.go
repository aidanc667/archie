package sinks

import "os/exec"

func RunShellInterpolated(cmd string) {
	exec.Command("sh", "-c", cmd)
}

func RunArgv() {
	exec.Command("ls", "-la")
}
