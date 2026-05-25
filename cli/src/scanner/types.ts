/** Evidence collected by a single check within a scanner category. */
export interface Evidence {
  signal: string;
  found: boolean;
  points: number;
  detail: string;
}

/** Result of scanning one category. */
export interface CategoryScore {
  category: string;
  maxPoints: number;
  earnedPoints: number;
  evidence: Evidence[];
}

/** PRISM level info derived from the total score. */
export interface PRISMLevelInfo {
  level: string;
  label: string;
  description: string;
}

/** Full scan result for a repository. */
export interface ScanResult {
  repoPath: string;
  repoName: string;
  scanDate: string;
  totalScore: number;
  maxScore: number;
  prismLevel: PRISMLevelInfo;
  categories: CategoryScore[];
  strengths: string[];
  gaps: string[];
  recommendations: string[];
}

/** Configuration passed to each scanner. */
export interface ScanConfig {
  repoPath: string;
  verbose: boolean;
  commitDepth: number;
}

export type OutputFormat = 'console' | 'json' | 'markdown';
