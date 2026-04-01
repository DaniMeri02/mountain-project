import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';

const fastify = Fastify({
  logger: true // Enable logging to see what happens in the terminal
});

// Register the plugin to serve static files from the 'public' folder
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/', 
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000 });
    console.log('🏔️ Portal is live! Visit http://localhost:3000 in your browser');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
