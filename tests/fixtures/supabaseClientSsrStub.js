export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
  },
};

export default supabase;
