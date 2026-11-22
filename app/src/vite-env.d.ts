/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Packed builds only (tools/pack-glasses.sh): the https answer server and the app's token. */
  readonly VITE_SERVER_URL?: string;
  readonly VITE_SERVER_TOKEN?: string;
}
