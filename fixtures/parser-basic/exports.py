def public_fn(x):
    return x + 1


def _private_fn(x):
    return x + 2


class PublicClass:
    def run(self):
        _private_fn(1)


class _PrivateClass:
    def run(self):
        pass
