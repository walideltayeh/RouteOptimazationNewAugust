import { createHash } from "crypto";
import type { DeviceFingerprint, OrgRiskProfile } from "@shared/schema";
import type { IStorage } from "./storage";

// ============================================
// TYPES
// ============================================

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high' | 'blocked';
  score: number;
  factors: string[];
}

export interface SharedSignalDetection {
  isShared: boolean;
  matchingTrialIds: string[];
  signalTypes: string[];
}

export interface BlockDecision {
  blocked: boolean;
  reason?: string;
  riskLevel: string;
  upgradeRequired?: boolean;
}

export interface FingerprintSignals {
  screenWidth?: number | null;
  screenHeight?: number | null;
  screenColorDepth?: number | null;
  devicePixelRatio?: number | null;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  maxTouchPoints?: number | null;
  timezone?: string | null;
  timezoneOffset?: number | null;
  platform?: string | null;
  language?: string | null;
  webglVendor?: string | null;
  webglRenderer?: string | null;
  webglHash?: string | null;
  canvasHash?: string | null;
  audioHash?: string | null;
  fontsHash?: string | null;
}

// Salt for org key generation (in production, use env variable)
const ORG_KEY_SALT = "trial-detection-v1-salt-2024";

// Public email providers that should be normalized
const PUBLIC_EMAIL_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'mail.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'yandex.com',
  'gmx.com',
  'gmx.net'
]);

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Extract /24 subnet from IPv4 or /48 from IPv6
 * Examples:
 *   "192.168.1.50" -> "192.168.1.0"
 *   "2001:db8:85a3::8a2e:370:7334" -> "2001:db8:85a3"
 */
export function extractIpSubnet(ip: string): string {
  if (!ip) return "unknown";
  
  // Handle localhost
  if (ip === "localhost" || ip === "127.0.0.1" || ip === "::1") {
    return "localhost";
  }
  
  // Remove IPv6 prefix if present (e.g., "::ffff:192.168.1.1")
  const cleanIp = ip.replace(/^::ffff:/i, "");
  
  // Check if IPv4
  const ipv4Parts = cleanIp.split(".");
  if (ipv4Parts.length === 4) {
    const parts = ipv4Parts.map(p => parseInt(p, 10));
    if (parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
      // Return /24 subnet (first 3 octets + .0)
      return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
  }
  
  // Check if IPv6
  if (cleanIp.includes(":")) {
    // Expand and normalize IPv6
    const expanded = expandIPv6(cleanIp);
    if (expanded) {
      // Return /48 subnet (first 3 groups)
      const groups = expanded.split(":");
      return `${groups[0]}:${groups[1]}:${groups[2]}`;
    }
  }
  
  return "unknown";
}

/**
 * Expand shortened IPv6 address
 */
function expandIPv6(ip: string): string | null {
  try {
    const parts = ip.split("::");
    if (parts.length > 2) return null;
    
    let left = parts[0] ? parts[0].split(":") : [];
    let right = parts[1] ? parts[1].split(":") : [];
    
    const missing = 8 - left.length - right.length;
    const middle = new Array(missing).fill("0000");
    
    const full = [...left, ...middle, ...right];
    return full.map(g => g.padStart(4, "0")).join(":");
  } catch {
    return null;
  }
}

/**
 * Extract domain from email and normalize public providers
 * Examples:
 *   "user@company.com" -> "company.com"
 *   "user@gmail.com" -> "public"
 */
export function extractEmailDomain(email: string): string {
  if (!email || typeof email !== "string") return "unknown";
  
  const parts = email.toLowerCase().trim().split("@");
  if (parts.length !== 2) return "unknown";
  
  const domain = parts[1];
  
  // Normalize public email providers
  if (PUBLIC_EMAIL_PROVIDERS.has(domain)) {
    return "public";
  }
  
  return domain;
}

/**
 * Generate a unique, salted hash for org identification
 * Combines IP subnet and email domain with SHA-256
 */
export function generateOrgKey(ipSubnet: string, emailDomain: string): string {
  const data = `${ORG_KEY_SALT}:${ipSubnet}:${emailDomain}`;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Calculate similarity score between two fingerprints (0-100)
 * Higher score means more similar (likely same device)
 */
export function calculateFingerprintSimilarity(
  fp1: FingerprintSignals,
  fp2: FingerprintSignals
): number {
  let totalWeight = 0;
  let matchedWeight = 0;
  
  // Define weights for each signal
  const weights = {
    // Screen signals (high weight - stable and distinctive)
    screenSize: 15,
    screenColorDepth: 5,
    devicePixelRatio: 8,
    
    // Hardware signals (high weight - hard to spoof)
    hardwareConcurrency: 12,
    deviceMemory: 10,
    maxTouchPoints: 5,
    
    // Time signals (medium weight)
    timezone: 8,
    timezoneOffset: 5,
    
    // Platform signals (medium weight)
    platform: 7,
    language: 5,
    
    // WebGL signals (high weight - very distinctive)
    webglVendor: 10,
    webglRenderer: 10,
    webglHash: 8,
    
    // Canvas/Audio (high weight - fingerprints)
    canvasHash: 15,
    audioHash: 10,
    fontsHash: 12
  };
  
  // Screen size comparison (width + height combined)
  if (fp1.screenWidth != null && fp1.screenHeight != null &&
      fp2.screenWidth != null && fp2.screenHeight != null) {
    totalWeight += weights.screenSize;
    if (fp1.screenWidth === fp2.screenWidth && fp1.screenHeight === fp2.screenHeight) {
      matchedWeight += weights.screenSize;
    }
  }
  
  // Color depth
  if (fp1.screenColorDepth != null && fp2.screenColorDepth != null) {
    totalWeight += weights.screenColorDepth;
    if (fp1.screenColorDepth === fp2.screenColorDepth) {
      matchedWeight += weights.screenColorDepth;
    }
  }
  
  // Device pixel ratio
  if (fp1.devicePixelRatio != null && fp2.devicePixelRatio != null) {
    totalWeight += weights.devicePixelRatio;
    if (Math.abs(fp1.devicePixelRatio - fp2.devicePixelRatio) < 0.01) {
      matchedWeight += weights.devicePixelRatio;
    }
  }
  
  // Hardware concurrency (CPU cores)
  if (fp1.hardwareConcurrency != null && fp2.hardwareConcurrency != null) {
    totalWeight += weights.hardwareConcurrency;
    if (fp1.hardwareConcurrency === fp2.hardwareConcurrency) {
      matchedWeight += weights.hardwareConcurrency;
    }
  }
  
  // Device memory
  if (fp1.deviceMemory != null && fp2.deviceMemory != null) {
    totalWeight += weights.deviceMemory;
    if (fp1.deviceMemory === fp2.deviceMemory) {
      matchedWeight += weights.deviceMemory;
    }
  }
  
  // Max touch points
  if (fp1.maxTouchPoints != null && fp2.maxTouchPoints != null) {
    totalWeight += weights.maxTouchPoints;
    if (fp1.maxTouchPoints === fp2.maxTouchPoints) {
      matchedWeight += weights.maxTouchPoints;
    }
  }
  
  // Timezone
  if (fp1.timezone && fp2.timezone) {
    totalWeight += weights.timezone;
    if (fp1.timezone === fp2.timezone) {
      matchedWeight += weights.timezone;
    }
  }
  
  // Timezone offset
  if (fp1.timezoneOffset != null && fp2.timezoneOffset != null) {
    totalWeight += weights.timezoneOffset;
    if (fp1.timezoneOffset === fp2.timezoneOffset) {
      matchedWeight += weights.timezoneOffset;
    }
  }
  
  // Platform
  if (fp1.platform && fp2.platform) {
    totalWeight += weights.platform;
    if (fp1.platform === fp2.platform) {
      matchedWeight += weights.platform;
    }
  }
  
  // Language
  if (fp1.language && fp2.language) {
    totalWeight += weights.language;
    if (fp1.language === fp2.language) {
      matchedWeight += weights.language;
    }
  }
  
  // WebGL vendor
  if (fp1.webglVendor && fp2.webglVendor) {
    totalWeight += weights.webglVendor;
    if (fp1.webglVendor === fp2.webglVendor) {
      matchedWeight += weights.webglVendor;
    }
  }
  
  // WebGL renderer
  if (fp1.webglRenderer && fp2.webglRenderer) {
    totalWeight += weights.webglRenderer;
    if (fp1.webglRenderer === fp2.webglRenderer) {
      matchedWeight += weights.webglRenderer;
    }
  }
  
  // WebGL hash
  if (fp1.webglHash && fp2.webglHash) {
    totalWeight += weights.webglHash;
    if (fp1.webglHash === fp2.webglHash) {
      matchedWeight += weights.webglHash;
    }
  }
  
  // Canvas hash
  if (fp1.canvasHash && fp2.canvasHash) {
    totalWeight += weights.canvasHash;
    if (fp1.canvasHash === fp2.canvasHash) {
      matchedWeight += weights.canvasHash;
    }
  }
  
  // Audio hash
  if (fp1.audioHash && fp2.audioHash) {
    totalWeight += weights.audioHash;
    if (fp1.audioHash === fp2.audioHash) {
      matchedWeight += weights.audioHash;
    }
  }
  
  // Fonts hash
  if (fp1.fontsHash && fp2.fontsHash) {
    totalWeight += weights.fontsHash;
    if (fp1.fontsHash === fp2.fontsHash) {
      matchedWeight += weights.fontsHash;
    }
  }
  
  // Calculate percentage
  if (totalWeight === 0) return 0;
  return Math.round((matchedWeight / totalWeight) * 100);
}

// ============================================
// RISK ASSESSMENT FUNCTIONS
// ============================================

/**
 * Assess organization risk level based on profile data
 */
export function assessOrgRisk(orgProfile: OrgRiskProfile): RiskAssessment {
  const factors: string[] = [];
  let score = 0;
  
  // Factor 1: Total trial count
  const trialCount = orgProfile.trialCount || 0;
  if (trialCount > 5) {
    score += 40;
    factors.push(`High trial count: ${trialCount} trials from this organization`);
  } else if (trialCount > 2) {
    score += 20;
    factors.push(`Multiple trials: ${trialCount} trials from this organization`);
  }
  
  // Factor 2: Active trial count (concurrent trials are suspicious)
  const activeTrialCount = orgProfile.activeTrialCount || 0;
  if (activeTrialCount > 1) {
    score += 30;
    factors.push(`Concurrent active trials: ${activeTrialCount} currently active`);
  }
  
  // Factor 3: Blocked trial count
  const blockedTrialCount = orgProfile.blockedTrialCount || 0;
  if (blockedTrialCount > 0) {
    score += 25;
    factors.push(`Previously blocked: ${blockedTrialCount} trials were blocked`);
  }
  
  // Factor 4: Shared fingerprints across trials
  const sharedSignals = orgProfile.sharedSignals as { fingerprintMatches?: number } | null;
  if (sharedSignals?.fingerprintMatches && sharedSignals.fingerprintMatches > 0) {
    score += 20;
    factors.push(`Shared device fingerprints detected across ${sharedSignals.fingerprintMatches} trials`);
  }
  
  // Factor 5: Linked fingerprints
  const linkedFingerprints = orgProfile.linkedFingerprints as string[] | null;
  if (linkedFingerprints && linkedFingerprints.length > 3) {
    score += 15;
    factors.push(`Multiple devices linked: ${linkedFingerprints.length} unique fingerprints`);
  }
  
  // Factor 6: Risk factors from profile
  const riskFactors = orgProfile.riskFactors as { velocity?: number; suspicious_pattern?: boolean } | null;
  if (riskFactors?.velocity && riskFactors.velocity > 0.5) {
    score += 15;
    factors.push("High velocity: Rapid trial creation detected");
  }
  if (riskFactors?.suspicious_pattern) {
    score += 10;
    factors.push("Suspicious pattern detected in usage");
  }
  
  // Factor 7: Check if already blocked
  if (orgProfile.blockedUntil && new Date(orgProfile.blockedUntil) > new Date()) {
    return {
      level: 'blocked',
      score: 100,
      factors: [`Organization blocked until ${orgProfile.blockedUntil}`, ...factors]
    };
  }
  
  // Determine level based on score
  let level: RiskAssessment['level'];
  if (score >= 70) {
    level = 'high';
  } else if (score >= 35) {
    level = 'medium';
  } else {
    level = 'low';
  }
  
  return { level, score: Math.min(score, 100), factors };
}

/**
 * Detect if a fingerprint is shared across other trials
 */
export function detectSharedFingerprints(
  newFingerprintHash: string,
  existingFingerprints: DeviceFingerprint[]
): SharedSignalDetection {
  const matchingTrialIds: string[] = [];
  const signalTypes: string[] = [];
  
  for (const fp of existingFingerprints) {
    // Check for exact fingerprint hash match
    if (fp.fingerprintHash === newFingerprintHash) {
      if (!matchingTrialIds.includes(fp.trialId)) {
        matchingTrialIds.push(fp.trialId);
      }
      if (!signalTypes.includes("exact_match")) {
        signalTypes.push("exact_match");
      }
    }
    
    // Check for canvas hash match (strong signal)
    // Note: This would require passing the new fingerprint signals for comparison
    // For now, we focus on hash matching
  }
  
  return {
    isShared: matchingTrialIds.length > 0,
    matchingTrialIds,
    signalTypes
  };
}

/**
 * Main decision function to determine if a trial should be blocked
 */
export async function shouldBlockTrial(
  email: string,
  orgKey: string,
  fingerprintHash: string | null,
  storage: IStorage
): Promise<BlockDecision> {
  const factors: string[] = [];
  let riskScore = 0;
  
  // Check 1: Existing trial with same email
  const existingTrialByEmail = await storage.getTrialAccountByEmail(email);
  if (existingTrialByEmail) {
    const status = existingTrialByEmail.status;
    if (status === 'active') {
      return {
        blocked: true,
        reason: "An active trial already exists for this email address",
        riskLevel: 'blocked',
        upgradeRequired: true
      };
    }
    if (status === 'blocked' || status === 'suspended') {
      return {
        blocked: true,
        reason: "This email has been blocked from creating new trials",
        riskLevel: 'blocked'
      };
    }
    if (status === 'converted') {
      return {
        blocked: true,
        reason: "This email has already been converted to a paid account",
        riskLevel: 'low',
        upgradeRequired: true
      };
    }
    // Previous expired trial - add to risk
    riskScore += 10;
    factors.push("Previous trial detected for this email");
  }
  
  // Check 2: Organization risk profile
  const orgProfile = await storage.getOrgRiskProfileByKey(orgKey);
  if (orgProfile) {
    const orgRisk = assessOrgRisk(orgProfile);
    riskScore += orgRisk.score;
    factors.push(...orgRisk.factors);
    
    if (orgRisk.level === 'blocked') {
      return {
        blocked: true,
        reason: orgProfile.blockReason || "Organization has been blocked from creating new trials",
        riskLevel: 'blocked'
      };
    }
    
    // Check for active trial from same org
    const activeOrgTrial = await storage.getActiveTrialByOrgKey(orgKey);
    if (activeOrgTrial && activeOrgTrial.email !== email) {
      riskScore += 25;
      factors.push("Active trial exists from same organization/office");
    }
  }
  
  // Check 3: Fingerprint analysis
  if (fingerprintHash) {
    const existingFingerprint = await storage.getDeviceFingerprintByHash(fingerprintHash);
    if (existingFingerprint) {
      // Same device used before
      const linkedTrial = await storage.getTrialAccount(existingFingerprint.trialId);
      if (linkedTrial) {
        if (linkedTrial.status === 'active') {
          return {
            blocked: true,
            reason: "This device already has an active trial",
            riskLevel: 'blocked',
            upgradeRequired: true
          };
        }
        if (linkedTrial.status === 'blocked') {
          return {
            blocked: true,
            reason: "This device has been blocked from creating new trials",
            riskLevel: 'blocked'
          };
        }
        riskScore += 20;
        factors.push("Device previously used for a trial");
      }
    }
  }
  
  // Determine final risk level
  let riskLevel: BlockDecision['riskLevel'];
  if (riskScore >= 70) {
    riskLevel = 'high';
  } else if (riskScore >= 35) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }
  
  // Block if risk is too high
  if (riskScore >= 80) {
    return {
      blocked: true,
      reason: `High risk detected: ${factors.slice(0, 2).join("; ")}`,
      riskLevel: 'high'
    };
  }
  
  return {
    blocked: false,
    riskLevel,
    reason: factors.length > 0 ? factors.join("; ") : undefined
  };
}
