from .helper import assist
import os


def do_work(x):
    return assist(x) + 1


class Worker:
    def run(self):
        do_work(1)
