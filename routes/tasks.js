const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { fail, resource, taskFields, readRoutes } = require('./support');

async function saveTask(body, id) {
    return mongoose.connection.transaction(async session => {
        const task = id === undefined ? new Task() : await resource(Task, id, session);
        const fields = taskFields(body);
        if (fields.assignedUser) {
            const user = await User.findById(fields.assignedUser).session(session);
            if (!user) fail(404, 'Assigned user not found.');
            if (body.assignedUserName !== undefined && fields.assignedUserName !== user.name) {
                fail(400, 'Assigned user name must match the selected user.');
            }
            fields.assignedUserName = user.name;
        } else {
            fields.assignedUserName = 'unassigned';
        }
        const taskId = task._id.toString();
        await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session });
        if (fields.assignedUser && !fields.completed) {
            await User.updateOne({ _id: fields.assignedUser }, { $addToSet: { pendingTasks: taskId } }, { session });
        }
        task.set(fields);
        await task.save({ session });
        return task.toObject();
    });
}

module.exports = function (router) {
    readRoutes(router, '/tasks', Task, 100);
    router.post('/tasks', async (req, res) => {
        const data = await saveTask(req.body);
        res.status(201).json({ message: 'Task created.', data });
    });
    router.put('/tasks/:id', async (req, res) => {
        const data = await saveTask(req.body, req.params.id);
        res.json({ message: 'Task updated.', data });
    });
    router.delete('/tasks/:id', async (req, res) => {
        await mongoose.connection.transaction(async session => {
            const task = await resource(Task, req.params.id, session);
            await User.updateMany({ pendingTasks: task._id.toString() }, {
                $pull: { pendingTasks: task._id.toString() }
            }, { session });
            await task.deleteOne({ session });
        });
        res.status(204).end();
    });
};
