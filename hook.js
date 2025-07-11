import supabase from "./db.js";

const getUser = async (waNumber) => {
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", waNumber)
    .single();

  return user;
};

export { getUser };
