import 'dotenv/config';

type EnvTypes = {
  PORT: string;
};

export const ALL_ENVS: EnvTypes = {
  PORT: process.env.PORT ?? '3000'
};
