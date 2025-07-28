import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart } from "lucide-react";
import type { Outlet } from "@shared/schema";

// Mock Chart.js for demonstration
declare global {
  interface Window {
    Chart: any;
  }
}

export default function AnalyticsCharts() {
  const distributionChartRef = useRef<HTMLCanvasElement>(null);
  
  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ["/api/outlets"],
  });

  useEffect(() => {
    // Load Chart.js dynamically
    const loadChartJS = async () => {
      if (window.Chart) return;
      
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
      script.onload = () => initializeCharts();
      document.head.appendChild(script);
    };

    const initializeCharts = () => {
      if (!window.Chart) return;



      // Visit Distribution Chart
      if (distributionChartRef.current) {
        const vf2Count = outlets.filter(o => o.visitFrequency === 2).length;
        const vf4Count = outlets.filter(o => o.visitFrequency === 4).length;
        
        const ctx = distributionChartRef.current.getContext('2d');
        new window.Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: ['VF2 Outlets', 'VF4 Outlets'],
            datasets: [{
              data: [vf2Count || 1642, vf4Count || 1205],
              backgroundColor: ['#1976D2', '#4CAF50'],
              borderWidth: 2,
              borderColor: '#ffffff'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  padding: 20,
                  usePointStyle: true
                }
              }
            }
          }
        });
      }
    };

    loadChartJS();
  }, [outlets]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <PieChart className="mr-2 h-5 w-5 text-primary" />
          Visit Distribution
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 relative">
          <canvas ref={distributionChartRef} className="w-full h-full"></canvas>
        </div>
      </CardContent>
    </Card>
  );
}
