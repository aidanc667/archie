# fixtures/security/secrets.py
import os

# Should flag: aws-access-key (AWS's own public documentation example key --
# not a real credential, used across every open-source secret scanner's tests)
aws_key = "AKIAIOSFODNN7EXAMPLE"

# Should flag: private-key-block (fake body, not a real key)
private_key = """
-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFErFakeFakeFakeFakeFakeFakeFake
-----END RSA PRIVATE KEY-----
"""

# Should flag: generic-secret-assignment (secret-shaped, not a real credential)
api_key = "sk-test-abcdefghijklmnopqrstuvwxyz"

# Should NOT flag: env-var reference is the correct pattern, not a literal secret
api_key_from_env = os.environ["API_KEY"]

# Should NOT flag: obvious placeholder value
secret = "changeme"
