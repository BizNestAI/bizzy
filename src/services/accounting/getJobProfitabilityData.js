// File: /services/getJobProfitabilityData.js

import { supabase } from '../supabaseClient.js';

const mockData = [
  {
    name: 'Kitchen Remodel - Smith',
    type: 'job',
    revenue: 15000,
    direct_costs: 9000,
    gross_profit: 6000,
    gross_margin_pct: 40.0
  },
  {
    name: 'Bathroom Renovation - Johnson',
    type: 'job',
    revenue: 10000,
    direct_costs: 8500,
    gross_profit: 1500,
    gross_margin_pct: 15.0
  },
  {
    name: 'HVAC Install - Davis',
    type: 'job',
    revenue: 20000,
    direct_costs: 10000,
    gross_profit: 10000,
    gross_margin_pct: 50.0
  }
];

export async function getJobProfitabilityData(userId, businessId, mode = 'job') {
  try {
    // Fetch data from Supabase
    const [jobsRes, costsRes, revenueRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('id, name, client_id, revenue')
        .eq('user_id', userId)
        .eq('business_id', businessId),

      supabase
        .from('job_costs')
        .select('job_id, labor_cost, material_cost, subcontractor_cost')
        .eq('user_id', userId)
        .eq('business_id', businessId),

      supabase
        .from('client_revenue')
        .select('client_id, client_name, total_revenue')
        .eq('user_id', userId)
        .eq('business_id', businessId)
    ]);

    if (jobsRes.error || costsRes.error || revenueRes.error) {
      console.warn('🔁 Falling back to mock job data');
      return mockData;
    }

    const jobs = jobsRes.data || [];
    const costs = costsRes.data || [];
    const clientRevenue = revenueRes.data || [];

    if (mode === 'client') {
      return clientRevenue.map((client) => {
        const clientJobs = jobs.filter((j) => j.client_id === client.client_id);
        const totalRevenue = client.total_revenue || 0;

        const totalCosts = clientJobs.reduce((acc, job) => {
          const cost = costs.find((c) => c.job_id === job.id);
          const jobCost = (cost?.labor_cost || 0) + (cost?.material_cost || 0) + (cost?.subcontractor_cost || 0);
          return acc + jobCost;
        }, 0);

        const profit = totalRevenue - totalCosts;
        const margin = totalRevenue ? (profit / totalRevenue) * 100 : 0;

        return {
          name: client.client_name,
          revenue: totalRevenue,
          direct_costs: totalCosts,
          gross_profit: profit,
          gross_margin_pct: margin.toFixed(1)
        };
      });
    } else {
      return jobs.map((job) => {
        const cost = costs.find((c) => c.job_id === job.id);
        const directCosts = (cost?.labor_cost || 0) + (cost?.material_cost || 0) + (cost?.subcontractor_cost || 0);
        const profit = (job.revenue || 0) - directCosts;
        const margin = job.revenue ? (profit / job.revenue) * 100 : 0;

        return {
          name: job.name,
          revenue: job.revenue || 0,
          direct_costs: directCosts,
          gross_profit: profit,
          gross_margin_pct: margin.toFixed(1)
        };
      });
    }
  } catch (err) {
    console.error('❌ Job profitability fetch failed:', err);
    return mockData;
  }
}
