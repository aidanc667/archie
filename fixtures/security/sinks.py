# fixtures/security/sinks.py
import os
import subprocess


def run_eval(x):
    return eval(x)


def run_exec(x):
    return exec(x)


def run_os_system(cmd):
    return os.system(cmd)


def run_shell_true(cmd):
    return subprocess.run(cmd, shell=True)


def run_argv_list(cmd):
    return subprocess.run(["ls", "-la"])
