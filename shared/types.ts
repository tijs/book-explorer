export interface BookRecord {
  $type: "buzz.bookhive.book";
  title: string;
  authors: string;
  hiveId: string;
  createdAt: string;
  status: string;
  cover?: {
    $type: "blob";
    ref: {
      $link: string;
    };
    mimeType: string;
    size: number;
  };
  startedAt?: string;
  finishedAt?: string;
  stars?: number;
  review?: string;
}

export type BookStatus =
  | "buzz.bookhive.defs#finished"
  | "buzz.bookhive.defs#reading"
  | "buzz.bookhive.defs#wantToRead"
  | "buzz.bookhive.defs#abandoned"
  | "buzz.bookhive.defs#owned";

export const STATUS_LABELS: Record<BookStatus, string> = {
  "buzz.bookhive.defs#finished": "Finished",
  "buzz.bookhive.defs#reading": "Currently Reading",
  "buzz.bookhive.defs#wantToRead": "Want to Read",
  "buzz.bookhive.defs#abandoned": "Abandoned",
  "buzz.bookhive.defs#owned": "Owned",
};

export interface AtProtoRecord {
  uri: string;
  cid: string;
  value: BookRecord;
}

export interface OAuthSession {
  did: string;
  handle: string;
  pdsUrl: string;
  accessToken: string;
  refreshToken: string;
  dpopPrivateKey: string;
  dpopPublicKey: string;
}

export interface OAuthState {
  state: string;
  codeVerifier: string;
  handle: string;
}
