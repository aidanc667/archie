// fixtures/security/secrets.ts

// Should flag: aws-access-key (AWS's own public documentation example key --
// not a real credential, used across every open-source secret scanner's tests)
const awsKey = "AKIAIOSFODNN7EXAMPLE";

// Should flag: private-key-block (fake body, not a real key)
const privateKey = `
-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFErFakeFakeFakeFakeFakeFakeFake
-----END RSA PRIVATE KEY-----
`;

// Should flag: generic-secret-assignment (secret-shaped, not a real credential)
const apiKey = "sk-test-abcdefghijklmnopqrstuvwxyz";

// Should NOT flag: env-var reference is the correct pattern, not a literal secret
const apiKeyFromEnv = process.env.API_KEY;

// Should NOT flag: obvious placeholder value
const secret = "changeme";
