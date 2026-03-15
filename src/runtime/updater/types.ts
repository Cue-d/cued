export interface UpdateReleaseState {
  checkedAt: number;
  channel: string;
  currentVersion: string;
  latestVersion: string | null;
  availableVersion: string | null;
  releaseUrl: string | null;
  tarballUrl: string | null;
  etag: string | null;
}

export interface PendingRollbackState {
  startedAt: number;
  previousVersion: string;
  targetVersion: string;
  installedAppPath: string;
  appBackupPath: string;
  dbBackupPath: string;
  releaseUrl: string | null;
}

export interface UpdateErrorState {
  at: number;
  stage: string;
  message: string;
  targetVersion: string | null;
}

export interface UpdateStatusSnapshot {
  currentVersion: string;
  releaseChannel: string;
  lastCheckedAt: number | null;
  latestVersion: string | null;
  availableVersion: string | null;
  available: boolean;
  releaseUrl: string | null;
  tarballUrl: string | null;
  pendingRollback: PendingRollbackState | null;
  lastError: UpdateErrorState | null;
}
