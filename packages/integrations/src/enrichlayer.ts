import { env } from "@cued/env/server";

const ENRICHLAYER_BASE_URL = "https://enrichlayer.com/api/v2";

export interface EnrichLayerProfileParams {
  profile_url?: string;
  twitter_profile_url?: string;
  facebook_profile_url?: string;
  extra?: "include" | "exclude";
  skills?: "include" | "exclude";
  personal_email?: "include" | "exclude";
  personal_contact_number?: "include" | "exclude";
  use_cache?: "if-present" | "if-recent";
  fallback_to_cache?: "on-error" | "never";
}

export interface EnrichLayerDate {
  day: number;
  month: number;
  year: number;
}

export interface EnrichLayerExperience {
  starts_at: EnrichLayerDate | null;
  ends_at: EnrichLayerDate | null;
  company: string;
  company_linkedin_profile_url: string | null;
  title: string;
  description: string | null;
  location: string | null;
  logo_url: string | null;
}

export interface EnrichLayerEducation {
  starts_at: EnrichLayerDate | null;
  ends_at: EnrichLayerDate | null;
  field_of_study: string | null;
  degree_name: string | null;
  school: string;
  school_linkedin_profile_url: string | null;
  description: string | null;
  logo_url: string | null;
  grade: string | null;
  activities_and_societies: string | null;
}

export interface EnrichLayerProfile {
  public_identifier: string;
  profile_pic_url: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  headline: string | null;
  summary: string | null;
  occupation: string | null;
  location_str: string | null;
  country: string | null;
  country_full_name: string | null;
  city: string | null;
  state: string | null;
  connections: number | null;
  follower_count: number | null;
  experiences: EnrichLayerExperience[];
  education: EnrichLayerEducation[];
  certifications: Array<{
    name: string;
    authority: string | null;
    starts_at: EnrichLayerDate | null;
    ends_at: EnrichLayerDate | null;
    license_number: string | null;
    url: string | null;
  }>;
  languages_and_proficiencies?: Array<{
    name: string;
    proficiency: string | null;
  }>;
  personal_emails?: string[];
  personal_numbers?: string[];
  meta: {
    thin_profile: boolean;
    last_updated: string;
  };
}

export async function fetchLinkedInProfile(
  profileUrl: string,
  opts: Omit<EnrichLayerProfileParams, "profile_url"> = {}
): Promise<EnrichLayerProfile> {
  const params = new URLSearchParams({
    profile_url: profileUrl,
    use_cache: opts.use_cache ?? "if-present",
    fallback_to_cache: opts.fallback_to_cache ?? "on-error",
  });

  if (opts.extra) params.set("extra", opts.extra);
  if (opts.skills) params.set("skills", opts.skills);
  if (opts.personal_email) params.set("personal_email", opts.personal_email);
  if (opts.personal_contact_number)
    params.set("personal_contact_number", opts.personal_contact_number);

  const res = await fetch(`${ENRICHLAYER_BASE_URL}/profile?${params}`, {
    headers: { Authorization: `Bearer ${env.ENRICHLAYER_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`EnrichLayer API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<EnrichLayerProfile>;
}
