/**
 * Loose types for the API's JSON shapes. The API is not fully documented with
 * a machine-readable schema, so these capture the fields we rely on and allow
 * unknown extras via index signatures. Verify field names against live
 * responses when extending.
 */

export interface Format {
  type?: string; // "html" | "pdf" | "xml" | ...
  url?: string;
  [k: string]: unknown;
}

export interface Version {
  version_id?: string;
  work_id?: string;
  title?: string;
  is_latest_version?: boolean;
  legislation_status?: string;
  administering_agencies?: string[];
  formats?: Format[];
  // Note: the API does not return a `version_date`; derive it from version_id
  // via util.dateFromVersionId().
  [k: string]: unknown;
}

export interface Work {
  work_id?: string;
  // Work objects carry no top-level title; the title lives on the version.
  legislation_type?: string;
  legislation_status?: string;
  administering_agencies?: string[];
  latest_matching_version?: Version;
  [k: string]: unknown;
}
