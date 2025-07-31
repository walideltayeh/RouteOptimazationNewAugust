# RouteOptima - Sales Rep Route Optimization Platform

## Overview

RouteOptima is a comprehensive sales rep route optimization platform that helps businesses optimize their sales representative territories and routes. The application processes outlet data, assigns reps to territories, and generates optimized schedules to maximize efficiency and minimize travel time. Now enhanced with machine learning capabilities for demand forecasting and territory optimization.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript
- **Build Tool**: Vite for fast development and optimized builds
- **UI Library**: Radix UI with shadcn/ui components for modern, accessible interface
- **Styling**: Tailwind CSS with custom color variables for consistent theming
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack Query (React Query) for server state management

### Backend Architecture
- **Runtime**: Node.js with Express.js server
- **Language**: TypeScript with ES modules
- **Database**: PostgreSQL with Drizzle ORM for type-safe database operations
- **Database Provider**: Neon serverless database
- **File Processing**: Support for CSV and Excel file uploads using Papa Parse and XLSX libraries
- **Session Management**: PostgreSQL sessions using connect-pg-simple

### Development Environment
- **Hot Reload**: Vite middleware integrated with Express for seamless development
- **Type Safety**: Shared TypeScript schemas between client and server
- **Code Quality**: Strict TypeScript configuration with path aliases

## Key Components

### Data Models
- **Outlets**: Store locations with GPS coordinates, visit frequencies (VF2/VF4), and territory assignments
- **Sales Reps**: Representatives with territory assignments, daily visit limits, and working schedules
- **Schedules**: Weekly route plans with optimized visit orders and distance calculations
- **Optimization Runs**: Historical records of route optimization executions with settings and results

### Core Features
1. **File Upload & Processing**: CSV/Excel file parsing for outlet data import
2. **Territory Management**: GPS-based clustering and rep assignment
3. **Route Optimization**: TSP (Traveling Salesman Problem) solving for efficient routes
4. **Schedule Generation**: Weekly schedule creation with visit frequency constraints
5. **Analytics Dashboard**: Metrics, charts, and performance visualization
6. **Interactive Map**: Territory visualization with outlet clustering
7. **ML Demand Forecasting**: AI-powered prediction of outlet visit requirements using historical patterns
8. **ML Territory Optimization**: Machine learning recommendations for optimal territory assignments

### Optimization Algorithms
- **K-means Clustering**: Groups outlets by geographic proximity
- **TSP Solver**: Nearest neighbor heuristic for route optimization
- **Visit Frequency Logic**: Handles VF2 (2 visits/week) and VF4 (4 visits/week) requirements
- **Enhanced Multi-Phase Workload Optimization**: 4-phase system for extreme workload balancing, geographic distribution, smart redistribution, and fine-tuning
- **ML Forecasting Engine**: Linear regression models for demand prediction with seasonal and trend analysis
- **AI Territory Optimization**: Machine learning-based recommendations for territory reassignments

## Data Flow

1. **Data Import**: Users upload CSV/Excel files containing outlet information
2. **Data Processing**: Files are parsed and validated, outlets are geocoded
3. **Territory Assignment**: Outlets are clustered and assigned to sales reps
4. **Route Optimization**: Routes are optimized using TSP algorithms
5. **Schedule Generation**: Weekly schedules are created with optimized visit orders
6. **Analytics**: Dashboard displays metrics, efficiency reports, and visualizations

## External Dependencies

### Database
- **Neon PostgreSQL**: Serverless PostgreSQL database
- **Drizzle ORM**: Type-safe database operations with migration support
- **Connection**: Environment variable `DATABASE_URL` required

### File Processing
- **Multer**: Multipart file upload handling
- **Papa Parse**: CSV file parsing
- **XLSX**: Excel file processing

### UI Components
- **Radix UI**: Accessible component primitives
- **Lucide React**: Icon library
- **Chart.js**: Data visualization (loaded dynamically)
- **Embla Carousel**: Component carousels

### Utilities
- **Date-fns**: Date manipulation
- **Class Variance Authority**: Component variant management
- **Clsx & Tailwind Merge**: Conditional CSS class handling

## Deployment Strategy

### Production Build
- **Frontend**: Vite builds optimized static assets to `dist/public`
- **Backend**: ESBuild bundles server code to `dist/index.js`
- **Environment**: Production mode serves static files and API routes

### Development Environment
- **Hot Reload**: Vite middleware provides instant updates
- **Error Handling**: Runtime error overlays for development
- **Logging**: Request/response logging for API endpoints

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string (required)
- `NODE_ENV`: Environment mode (development/production)

### Scripts
- `npm run dev`: Start development server with hot reload
- `npm run build`: Build production assets
- `npm run start`: Start production server
- `npm run db:push`: Push database schema changes

## Recent Changes (July 2025)

✓ Fixed critical app crashes caused by JavaScript syntax errors
✓ Implemented enhanced 4-phase grouping optimization system
✓ Added machine learning capabilities for demand forecasting
✓ Created ML insights dashboard with predictive analytics
✓ Integrated territory optimization recommendations using AI
✓ Enhanced workload balancing with multi-phase algorithms
✓ Added comprehensive ML model performance tracking
✓ **Fixed Territory Overlap Issue**: Replaced round-robin assignment with proper geographic K-means clustering
✓ **Updated Visit Parameters**: Changed from 15-25 to 25-30 visits per day across all components
✓ **Enhanced Map Toggle**: Added cluster/individual view switching with zone-specific filtering
✓ **Improved Clustering Algorithm**: Grid-based initialization, Haversine distance, convergence detection
✓ **Implemented Compact Clustering**: New 2-phase algorithm creates 25-outlet clusters within 5km radius for geographic proximity
✓ **Added New Optimization Button**: Clear all data functionality to reset for fresh optimization runs
✓ **Implemented Enhanced Compact Zone Merger**: 3-phase merging system ensuring zones with ≤5 outlets automatically merge with closest zones
✓ **Added Enhanced Boundary Optimization**: Phase 2 redistribution of outlier outlets to closer zones for better geographic clustering
✓ **Implemented Multi-Zone Selection**: Users can now select multiple zones on the map for comparison and analysis
✓ **Enhanced Territory Dropdown to Multi-Select**: Converted single-select dropdown to multi-select with search functionality for selecting multiple zones simultaneously
✓ **Optimized Map Display for Large Datasets**: Increased threshold from 1000 to 5000 outlets for map rendering to handle larger Lebanese datasets
✓ **Fixed Oversized Zone Issue**: Added Phase 4 cluster splitting logic to break down zones with >25 outlets into optimal 25-outlet sub-zones
✓ **Fixed Dropdown Scrolling**: Implemented proper scrolling constraints for multi-select territory dropdown using Command component's built-in scroll handling
✓ **Enforced Strict Zone Size Limits**: Updated clustering algorithm to ensure no zone exceeds 25 outlets by implementing strict size checks during cluster assignment
✓ **Enhanced Zone Merger Logic**: Improved 5-phase merging system to ensure all zones with ≤5 outlets are merged with their closest neighbor that has capacity
✓ **Implemented Improved K-means Clustering**: Replaced basic clustering with advanced k-means++ initialization and size-constrained assignment for better geographic distribution
✓ **Fixed File Upload After Clear**: Resolved issue where file upload wouldn't work after clearing data
✓ **Replaced Route Efficiency Graph**: Changed to Territory Balance metric for better territory distribution insights
✓ **Updated Default Visit Parameters**: Min/Max visits changed from 15/25 to 25/30 for realistic Lebanese market conditions
✓ **Transformed System to Route-Based**: Each Zone now becomes a Route (Route 1, Route 2, etc.) instead of rep assignments
✓ **Implemented Weekly Schedule Pattern**: Week 1 = Week 3, Week 2 = Week 4 for consistent visit cycles
✓ **Removed Territory Balance Trends Chart**: Simplified analytics to show only essential Visit Distribution metrics
✓ **Fixed Recommendation Sequence**: Initial estimate shows during upload (~X reps), final recommendation shows after optimization
✓ **Updated Dashboard Layout**: Map now takes full width with zones displayed below for better visualization
✓ **Implemented Drag-and-Drop Territory Customization**: Users can manually reassign outlets between zones by dragging them in a visual interface, with automatic schedule regeneration after saving changes
✓ **Added "Move to Zone" Dropdown Buttons**: Each outlet now has a "Move" button with dropdown menu showing all other zones, making it easy to transfer outlets to specific zones without needing to see all zones on screen
✓ **Rewrote Clustering Algorithm for Geographic Proximity**: New algorithm builds clusters by finding dense areas first, ensuring all 25 outlets in each zone are geographically close together (within 5km radius when possible)
✓ **Improved Clustering with Gradual Radius Expansion**: Algorithm now starts with 2km radius and gradually expands by 0.5km increments until reaching 25 outlets per zone, ensuring tighter geographic clustering
✓ **Implemented Advanced Clustering Algorithm in JavaScript**: Successfully implemented HDBSCAN (density-based clustering), VRP optimization (route planning), and Capacitated K-Means (size-constrained clustering) entirely in JavaScript without Python dependencies
✓ **Separated Rep Map as Standalone Feature**: Created dedicated Rep Map page accessible from sidebar navigation, no longer part of Dashboard
✓ **Fixed Rep Map Functionality**: Resolved day-of-week comparison issue and implemented proper route visualization with numbered markers

The application follows a monorepo structure with clear separation between client, server, and shared code, enabling efficient development and maintainable architecture for scaling route optimization operations with advanced AI capabilities.