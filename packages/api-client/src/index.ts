/**
 * @visarium/api-client — typed access to the server API.
 *
 * The `paths` / `components` types are edited by hand alongside the Rust
 * server, which server/tests/api.rs holds to them; the auth and
 * sharing endpoints are the hand-written block at the end of schema.ts.
 */

export * from './client';
export type {
  components,
  Identities,
  Invitation,
  InvitationInfo,
  operations,
  paths,
  SessionView,
  SharedBoard,
  SharedSession,
  ShareLink,
} from './generated/schema';
export * from './meta';
