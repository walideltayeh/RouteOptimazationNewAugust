#!/usr/bin/env python3
import json
import sys
import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics.pairwise import haversine_distances
import hdbscan
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp
import warnings
warnings.filterwarnings('ignore')

def haversine_distance(lat1, lon1, lat2, lon2):
    """Calculate haversine distance in kilometers"""
    R = 6371  # Earth's radius in km
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat/2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon/2)**2
    c = 2 * np.arcsin(np.sqrt(a))
    return R * c

def create_distance_matrix(outlets):
    """Create distance matrix for all outlets"""
    coords = np.array([[o['latitude'], o['longitude']] for o in outlets])
    coords_rad = np.radians(coords)
    dist_matrix = haversine_distances(coords_rad) * 6371  # Convert to km
    return dist_matrix

def perform_hdbscan_clustering(outlets, min_cluster_size=15, min_samples=5):
    """Step 1: Use HDBSCAN for initial geographic clustering"""
    coords = np.array([[o['latitude'], o['longitude']] for o in outlets])
    
    # HDBSCAN clustering
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric='haversine',
        cluster_selection_method='eom',
        alpha=1.0
    )
    
    # Convert to radians for haversine metric
    coords_rad = np.radians(coords)
    cluster_labels = clusterer.fit_predict(coords_rad)
    
    # Group outlets by cluster
    clusters = {}
    for i, label in enumerate(cluster_labels):
        if label == -1:  # Noise points
            continue
        if label not in clusters:
            clusters[label] = []
        clusters[label].append(i)
    
    return clusters, cluster_labels

def optimize_route_with_ortools(outlets, depot_index=0, max_outlets_per_day=25):
    """Step 2: Use Google OR-Tools for route optimization within a cluster"""
    if len(outlets) <= max_outlets_per_day:
        return [list(range(len(outlets)))]
    
    # Create distance matrix
    distance_matrix = []
    for i in range(len(outlets)):
        row = []
        for j in range(len(outlets)):
            if i == j:
                row.append(0)
            else:
                dist = haversine_distance(
                    outlets[i]['latitude'], outlets[i]['longitude'],
                    outlets[j]['latitude'], outlets[j]['longitude']
                )
                row.append(int(dist * 1000))  # Convert to meters for OR-Tools
        distance_matrix.append(row)
    
    # Create the routing index manager
    manager = pywrapcp.RoutingIndexManager(len(outlets), 1, depot_index)
    
    # Create Routing Model
    routing = pywrapcp.RoutingModel(manager)
    
    # Create distance callback
    def distance_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return distance_matrix[from_node][to_node]
    
    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
    
    # Add capacity constraint (outlets per day)
    def demand_callback(from_index):
        return 1
    
    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,  # null capacity slack
        [max_outlets_per_day],  # vehicle maximum capacities
        True,  # start cumul to zero
        'Capacity'
    )
    
    # Setting first solution heuristic
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_parameters.time_limit.FromSeconds(5)
    
    # Solve the problem
    solution = routing.SolveWithParameters(search_parameters)
    
    if solution:
        routes = []
        index = routing.Start(0)
        route = []
        while not routing.IsEnd(index):
            node_index = manager.IndexToNode(index)
            if node_index != depot_index:
                route.append(node_index)
            index = solution.Value(routing.NextVar(index))
        if route:
            routes.append(route)
        return routes
    
    # Fallback to simple grouping if OR-Tools fails
    return [list(range(i, min(i + max_outlets_per_day, len(outlets)))) 
            for i in range(0, len(outlets), max_outlets_per_day)]

def capacitated_kmeans(outlets, n_clusters, cluster_capacity=25, max_iterations=100):
    """Step 3: Capacitated K-Means to ensure clusters align with rep count"""
    coords = np.array([[o['latitude'], o['longitude']] for o in outlets])
    n_outlets = len(outlets)
    
    # Initialize centroids using K-means++
    kmeans = KMeans(n_clusters=n_clusters, init='k-means++', n_init=1, max_iter=1)
    kmeans.fit(np.radians(coords))
    centroids = kmeans.cluster_centers_
    
    for iteration in range(max_iterations):
        # Calculate distances to centroids
        distances = np.zeros((n_outlets, n_clusters))
        for i in range(n_outlets):
            for j in range(n_clusters):
                distances[i, j] = haversine_distance(
                    coords[i, 0], coords[i, 1],
                    np.degrees(centroids[j, 0]), np.degrees(centroids[j, 1])
                )
        
        # Assign outlets to clusters with capacity constraints
        assignments = np.full(n_outlets, -1)
        cluster_sizes = np.zeros(n_clusters, dtype=int)
        
        # Sort outlets by minimum distance to any centroid
        min_distances = np.min(distances, axis=1)
        sorted_indices = np.argsort(min_distances)
        
        for idx in sorted_indices:
            # Find closest cluster with capacity
            sorted_clusters = np.argsort(distances[idx])
            for cluster_id in sorted_clusters:
                if cluster_sizes[cluster_id] < cluster_capacity:
                    assignments[idx] = cluster_id
                    cluster_sizes[cluster_id] += 1
                    break
        
        # Update centroids
        new_centroids = np.zeros_like(centroids)
        for j in range(n_clusters):
            cluster_outlets = coords[assignments == j]
            if len(cluster_outlets) > 0:
                new_centroids[j] = np.radians(np.mean(cluster_outlets, axis=0))
            else:
                new_centroids[j] = centroids[j]
        
        # Check convergence
        if np.allclose(centroids, new_centroids, rtol=1e-5):
            break
        
        centroids = new_centroids
    
    # Group outlets by cluster
    clusters = []
    for j in range(n_clusters):
        cluster_outlets = [outlets[i] for i in range(n_outlets) if assignments[i] == j]
        if cluster_outlets:
            clusters.append(cluster_outlets)
    
    return clusters

def main():
    # Read input from stdin
    input_data = json.loads(sys.stdin.read())
    outlets = input_data['outlets']
    target_zones = input_data['targetZones']
    
    print(f"Processing {len(outlets)} outlets into {target_zones} zones", file=sys.stderr)
    
    # Step 1: HDBSCAN for initial geographic clustering
    hdbscan_clusters, labels = perform_hdbscan_clustering(outlets, min_cluster_size=10, min_samples=3)
    print(f"HDBSCAN found {len(hdbscan_clusters)} initial clusters", file=sys.stderr)
    
    # Step 2: Apply OR-Tools optimization to large clusters
    optimized_subclusters = []
    for cluster_id, outlet_indices in hdbscan_clusters.items():
        cluster_outlets = [outlets[i] for i in outlet_indices]
        
        if len(cluster_outlets) > 25:
            # Use OR-Tools to optimize routes within this cluster
            routes = optimize_route_with_ortools(cluster_outlets, max_outlets_per_day=25)
            for route in routes:
                subcluster = [cluster_outlets[i] for i in route]
                if subcluster:
                    optimized_subclusters.append(subcluster)
        else:
            optimized_subclusters.append(cluster_outlets)
    
    # Handle noise points (outlets not in any HDBSCAN cluster)
    noise_outlets = [outlets[i] for i in range(len(outlets)) if labels[i] == -1]
    if noise_outlets:
        # Group noise points geographically
        if len(noise_outlets) > 25:
            n_noise_clusters = max(1, len(noise_outlets) // 25)
            noise_clusters = capacitated_kmeans(noise_outlets, n_noise_clusters, cluster_capacity=25)
            optimized_subclusters.extend(noise_clusters)
        else:
            optimized_subclusters.append(noise_outlets)
    
    print(f"After OR-Tools optimization: {len(optimized_subclusters)} subclusters", file=sys.stderr)
    
    # Step 3: Use Capacitated K-Means to merge/split clusters to match target zones
    all_outlets_flat = []
    for subcluster in optimized_subclusters:
        all_outlets_flat.extend(subcluster)
    
    final_clusters = capacitated_kmeans(all_outlets_flat, target_zones, cluster_capacity=25)
    
    # Format output
    result = []
    for i, cluster_outlets in enumerate(final_clusters):
        # Calculate cluster centroid
        if cluster_outlets:
            centroid_lat = np.mean([o['latitude'] for o in cluster_outlets])
            centroid_lng = np.mean([o['longitude'] for o in cluster_outlets])
            
            # Calculate cluster radius
            max_dist = 0
            for outlet in cluster_outlets:
                dist = haversine_distance(
                    outlet['latitude'], outlet['longitude'],
                    centroid_lat, centroid_lng
                )
                max_dist = max(max_dist, dist)
            
            result.append({
                'id': i,
                'outlets': cluster_outlets,
                'centroid': {'lat': centroid_lat, 'lng': centroid_lng},
                'radius': max_dist
            })
    
    # Output result as JSON
    print(json.dumps(result))

if __name__ == '__main__':
    main()