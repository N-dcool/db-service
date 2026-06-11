async function authMiddleware(request, response) {
    try{
        await request.jwtVerify();
    } catch(err) {
        console.error('JWT verification failed:', err);
        response.code(401).send({error: 'Unauthorized'});
    }
}

module.exports = authMiddleware;