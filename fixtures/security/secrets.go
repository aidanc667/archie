// fixtures/security/secrets.go
package secrets

import "os"

// Should flag: aws-access-key (AWS's own public documentation example key --
// not a real credential, used across every open-source secret scanner's tests)
const AwsKey = "AKIAIOSFODNN7EXAMPLE"

// Should flag: private-key-block (fake body, not a real key)
const PrivateKey = `
-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFErFakeFakeFakeFakeFakeFakeFake
-----END RSA PRIVATE KEY-----
`

func Example() string {
	// Should flag: generic-secret-assignment (secret-shaped, not a real credential);
	// Go's `:=` short assignment needs the same detection as `=` elsewhere.
	apiKey := "sk-test-abcdefghijklmnopqrstuvwxyz"

	// Should NOT flag: env-var reference is the correct pattern, not a literal secret
	apiKeyFromEnv := os.Getenv("API_KEY")

	// Should NOT flag: obvious placeholder value
	secret := "changeme"

	return apiKey + apiKeyFromEnv + secret
}
