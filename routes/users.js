const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { fail, resource, userFields, readRoutes } = require('./support');

async function saveUser(body, id) {
    return mongoose.connection.transaction(async session => {
        const user = id === undefined ? new User() : await resource(User, id, session);
        const fields = userFields(body);
        if (await User.exists({ email: fields.email, _id: { $ne: user._id } }).session(session)) {
            fail(400, 'That email address is already in use.');
        }
        const tasks = await Task.find({ _id: { $in: fields.pendingTasks } }).session(session);
        if (tasks.some(task => task.completed)) fail(400, 'Completed tasks cannot be included in pending tasks.');
        if (tasks.length !== fields.pendingTasks.length) fail(404, 'One or more pending tasks were not found.');
        const userId = user._id.toString();
        const removed = user.pendingTasks.filter(taskId => !fields.pendingTasks.includes(taskId));
        await Task.updateMany({ _id: { $in: removed }, assignedUser: userId }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
        await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: fields.pendingTasks } }, {
            $pull: { pendingTasks: { $in: fields.pendingTasks } }
        }, { session });
        await Task.updateMany({ _id: { $in: fields.pendingTasks } }, {
            $set: { assignedUser: userId, assignedUserName: fields.name }
        }, { session });
        await Task.updateMany({ assignedUser: userId }, {
            $set: { assignedUserName: fields.name }
        }, { session });
        user.set(fields);
        await user.save({ session });
        return user.toObject();
    });
}

module.exports = function (router) {
    readRoutes(router, '/users', User, 0);
    router.post('/users', async (req, res) => {
        const data = await saveUser(req.body);
        res.status(201).json({ message: 'User created.', data });
    });
    router.put('/users/:id', async (req, res) => {
        const data = await saveUser(req.body, req.params.id);
        res.json({ message: 'User updated.', data });
    });
    router.delete('/users/:id', async (req, res) => {
        await mongoose.connection.transaction(async session => {
            const user = await resource(User, req.params.id, session);
            await Task.updateMany({ assignedUser: user._id.toString() }, {
                $set: { assignedUser: '', assignedUserName: 'unassigned' }
            }, { session });
            await user.deleteOne({ session });
        });
        res.status(204).end();
    });
};
