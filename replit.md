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
- **Schedule Generation**: Weekly schedule creation respecting visit frequency constraints (VF1, VF2, VF4).
- **Analytics & Visualization**: Interactive map for territory visualization, analytics dashboard, and ML insights.
- **Machine Learning**: Demand forecasting using linear regression models with seasonal and trend analysis.
- **Vehicle Management**: CRUD API for fleet tracking, maintenance history, and a predictive maintenance forecasting system based on mileage and configurable thresholds. Includes a detailed Vehicle Detail Dashboard and export functionality.
- **Interactive Reassignment**: Manual drag-and-drop or "Move to Zone" functionality for reassigning outlets with automatic schedule regeneration.
- **Dynamic Zone Sizing**: Clustering algorithms respect user-defined min/max outlet parameters.
- **Hierarchy-Based Visit Follow-Up**: Role hierarchy system where Merchandisers and Collection Agents automatically follow Sales Rep routes with configurable day offsets (e.g., Rep Day 0, Merchandiser Day +1, Collection Agent Day +2). Preserves outlet order and route sequence across all roles with automatic cascade regeneration when Rep schedule changes.

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