import type {
  Pty as SDKPty,
  PtyCreateData as SDKPtyCreateData,
  PtyUpdateData as SDKPtyUpdateData,
} from "./legacy-sdk.ts"

export type PtySize = NonNullable<NonNullable<SDKPtyUpdateData['body']>['size']>

export type Pty = SDKPty

export type PtyCreateParams = NonNullable<SDKPtyCreateData['body']>

export type PtyUpdateParams = NonNullable<SDKPtyUpdateData['body']>
