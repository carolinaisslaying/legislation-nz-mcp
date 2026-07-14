/**
 * Types for the legislation.govt.nz API JSON response shapes.
 *
 * Field names and types confirmed against live responses (Privacy Act 2020,
 * July 2026). Type-specific fields (act_type, bill_status, etc.) are optional
 * because the API serves multiple legislation categories from the same endpoints
 * and not all fields appear on every type.
 */

export interface Format {
  type: string;  // "html" | "pdf" | "xml" | "pdf_original_scan"
  url: string;
}

export interface Version {
  version_id: string;
  work_id: string;
  title: string;
  legislation_type: string;   // "act" | "bill" | "secondary_legislation" | "amendment_paper"
  legislation_status: string; // "in_force" | "not_in_force" | "no_value"
  is_latest_version?: boolean;
  administering_agencies: string[];
  formats: Format[];
  // Act-specific
  act_type?: string;          // "public" | "local" | "private"
  act_status?: string;        // "in_force" | "repealed" | ...
  act_classification?: string;
  // Bill-specific
  bill_type?: string;
  bill_status?: string;
  // Secondary legislation-specific
  instrument_type_group?: string;
  instrument_status?: string;
  instrument_classification?: string;
}

export interface Work {
  work_id: string;
  // Note: title is NOT on the work object — it lives on latest_matching_version.title
  legislation_type: string;
  legislation_status: string;
  administering_agencies: string[];
  publisher?: string;         // "Parliamentary Counsel Office" | "Agency"
  latest_matching_version?: Version;
  // Act-specific
  act_type?: string;
  act_status?: string;
  act_classification?: string;
  // Bill-specific
  bill_type?: string;
  bill_status?: string;
  // Secondary legislation-specific
  instrument_type_group?: string;
  instrument_status?: string;
  instrument_classification?: string;
}
