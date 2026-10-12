const MISSING_CREDENTIAL_MESSAGE =
  "no GitHub credential supplied — provide 'github-token' (fine-grained PAT with read access to the service repos) " +
  "or 'app-id' + 'app-private-key' (GitHub App). The default GITHUB_TOKEN cannot read sibling repos.";
const MISSING_EXCHANGER_MESSAGE = "internal: no installation-token exchanger configured";

export class AuthConfigError extends Error {}

export type AuthInput = {
  githubToken?: string;
  appId?: string;
  appPrivateKey?: string;
  createInstallationToken?: (appId: string, privateKey: string) => Promise<string>;
};

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export async function resolveToken(input: AuthInput): Promise<string> {
  if (hasText(input.githubToken)) {
    return input.githubToken;
  }
  if (hasText(input.appId) && hasText(input.appPrivateKey)) {
    if (!input.createInstallationToken) {
      throw new AuthConfigError(MISSING_EXCHANGER_MESSAGE);
    }
    return input.createInstallationToken(input.appId, input.appPrivateKey);
  }
  throw new AuthConfigError(MISSING_CREDENTIAL_MESSAGE);
}
