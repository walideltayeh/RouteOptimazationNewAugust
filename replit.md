# RouteOptima - Sales Rep Route Optimization Platform

## Overview

RouteOptima is a comprehensive platform designed to optimize sales representative territories and routes. It processes outlet data, assigns reps to territories, and generates efficient schedules to maximize productivity and minimize travel time. The platform integrates machine learning for demand forecasting and territory optimization, aiming to provide businesses with a scalable solution for managing sales operations.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React with TypeScript, using Vite for development and build.
- **UI/UX**: Radix UI and shadcn/ui components for a modern, accessible interface, styled with Tailwind CSS and custom color variables.
- **State Management**: TanStack Query (React Query) for server state management.

### Backend
- **Runtime**: Node.js with Express.js server, written in TypeScript.
- **Database**: PostgreSQL via Neon (serverless database) with Drizzle ORM for type-safe operations.
- **File Processing**: Handles CSV and Excel uploads.
- **Session Management**: PostgreSQL sessions.

### Core Features
- **Data Management**: Outlets, Sales Reps, Schedules, and Optimization Runs data models.
- **Data Import**: CSV/Excel file parsing and geocoding.
- **Territory Management**: GPS-based clustering, rep assignment, and ML-driven recommendations for optimal assignments.
- **Route Optimization**: Utilizes TSP (Traveling Salesman Problem) solving with heuristics (e.g., nearest neighbor) and multi-phase workload optimization, including K-means clustering for geographic grouping.
- **Schedule Generation**: Two-level geographic scheduling: (1) global clustering assigns outlets to reps, (2) per-rep K-means++ sub-clustering creates exactly `workingDaysPerWeek` geographically-tight daily groups. Each day's route visits one compact geographic area. Respects visit frequency constraints (VF4=weekly, VF2=biweekly alternating weeks 1+3/2+4, VF1=monthly one week only).
- **Analytics & Visualization**: Interactive map for territory visualization, analytics dashboard, and ML insights.
- **Machine Learning**: Demand forecasting using linear regression models with seasonal and trend analysis.
- **Vehicle Management**: CRUD API for fleet tracking, maintenance history, and a predictive maintenance forecasting system based on mileage and configurable thresholds. Includes a detailed Vehicle Detail Dashboard and export functionality.
- **Interactive Reassignment**: Manual drag-and-drop or "Move to Zone" functionality for reassigning outlets with automatic schedule regeneration.
- **Dynamic Zone Sizing**: Clustering algorithms respect user-defined min/max outlet parameters.
- **Hierarchy-Based Visit Follow-Up**: Role hierarchy system where Merchandisers and Collection Agents automatically follow Sales Rep routes with configurable day offsets (e.g., Rep Day 0, Merchandiser Day +1, Collection Agent Day +2). Preserves outlet order and route sequence across all roles with automatic cascade regeneration when Rep schedule changes.

### Trial Management System
A comprehensive 360° trial management solution with strict anti-abuse measures:

**Trial Limits:**
- Maximum 100 outlets per trial account
- Maximum 2 vehicles per trial account
- 14-day trial duration
- Enforced at both UI and backend levels with 402 responses when exceeded

**Anti-Abuse & Device Fingerprinting:**
- Browser signals: userAgent, platform, language, timezone
- Hardware signals: CPU cores, device memory, screen dimensions
- Canvas, WebGL, and audio fingerprinting for unique device identification
- Persistent identifiers via localStorage, sessionStorage, and cookies
- SHA-256 hashing for privacy-compliant fingerprint storage
- Server-side fingerprint validation (doesn't trust client hash)

**Office-Level Detection:**
- IP subnet (/24) extraction for network grouping
- Email domain analysis with public provider normalization
- Org key generation combining IP + domain signals
- Shared fingerprint detection across trials
- Risk scoring with automatic escalation (low → medium → high → blocked)
- Velocity tracking (time between trials from same org)

**UI Components:**
- Trial onboarding modal with multi-step consent flow
- Trial banner showing usage stats and days remaining
- Upgrade modal for limit-reached scenarios
- Usage indicators in outlet/vehicle forms
- Warning banners when approaching limits

**Database Tables:**
- trialAccounts: Core trial data with status and limits
- trialUsage: Usage tracking (outlet/vehicle counts)
- deviceFingerprints: Device identification data
- fingerprintEvents: Audit trail for security
- orgRiskProfiles: Organization-level risk assessment
- trialConversions: Upgrade tracking

### Technical Implementations
- **Monorepo Structure**: Clear separation between client, server, and shared code.
- **Type Safety**: Shared TypeScript schemas between client and server.
- **Clustering Algorithms**: Advanced K-means++, HDBSCAN, VRP, and capacitated K-Means for geographic proximity and size-constrained clustering, implemented in JavaScript.
- **Multi-Day Selection**: Rep map allows viewing multiple days simultaneously.
- **Export Functionality**: Supports exporting schedules and vehicle summaries to Excel.

### Performance Optimizations (Large Dataset Support: 2000-5000+ outlets)
- **Spatial Grid Indexing**: SpatialGrid class provides O(1) neighbor lookups instead of O(n) pairwise distance calculations. Uses 2km grid cells to index outlets by geographic location.
- **Optimized Clustering**: The createExact25OutletClusters function uses the spatial grid for efficient neighbor queries and sample-based seed selection (samples 100 outlets) to reduce complexity from O(n²) to O(n*k).
- **GeoJSON Map Rendering**: For datasets with 100+ outlets, the map uses Mapbox GL circle and symbol layers instead of individual DOM markers. This reduces DOM node count from thousands to a few layers, dramatically improving rendering performance.
- **Event Handler Cleanup**: GeoJSON layer event handlers are tracked and properly cleaned up on re-render to prevent memory leaks and duplicate handlers.

## External Dependencies

### Database
- **Neon PostgreSQL**: Serverless PostgreSQL database.
- **Drizzle ORM**: Type-safe database operations.

### File Processing
- **Multer**: Multipart file upload handling.
- **Papa Parse**: CSV file parsing.
- **XLSX**: Excel file processing.

### UI Components
- **Radix UI**: Accessible component primitives.
- **Lucide React**: Icon library.
- **Chart.js**: Data visualization.
- **Embla Carousel**: Component carousels.

### Utilities
- **Date-fns**: Date manipulation.
- **Class Variance Authority**: Component variant management.
- **Clsx & Tailwind Merge**: Conditional CSS class handling.