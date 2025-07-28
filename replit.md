# RouteOptima - Sales Rep Route Optimization Platform

## Overview

RouteOptima is a comprehensive sales rep route optimization platform that helps businesses optimize their sales representative territories and routes. The application processes outlet data, assigns reps to territories, and generates optimized schedules to maximize efficiency and minimize travel time.

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

### Optimization Algorithms
- **K-means Clustering**: Groups outlets by geographic proximity
- **TSP Solver**: Nearest neighbor heuristic for route optimization
- **Visit Frequency Logic**: Handles VF2 (2 visits/week) and VF4 (4 visits/week) requirements
- **Workload Balancing**: Ensures rep capacity constraints are respected

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

The application follows a monorepo structure with clear separation between client, server, and shared code, enabling efficient development and maintainable architecture for scaling route optimization operations.