/**
 * @visarium/api-client — typed access to the server API.
 *
 * The `paths` / `components` types are edited by hand alongside the Rust
 * server, which server/tests/api.rs holds to them; the auth and
 * sharing endpoints are the hand-written block at the end of schema.ts.
 */

export * from './client';
export type {
  AgentSettings,
  AgentToken,
  components,
  Identities,
  Invitation,
  InvitationInfo,
  NewAgentToken,
  OAuthRequest,
  operations,
  paths,
  Role,
  SessionView,
  SharedBoard,
  SharedSession,
  ShareLink,
  SignInProvider,
  SignInProviders,
  StorageUsage,
  VisionSetting,
  VisionSettingInput,
} from './generated/schema';
export * from './meta';
