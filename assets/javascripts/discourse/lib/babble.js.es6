import Post from 'discourse/models/post'
import Topic from 'discourse/models/topic'
import User from 'discourse/models/user'
import elementIsVisible from '../lib/element-is-visible'
import lastVisibleElement from '../lib/last-visible-element'
import debounce from 'discourse/lib/debounce'
import { ajax } from 'discourse/lib/ajax'
import { scrollToPost, setupScrollContainer, setupComposer, teardownComposer, hasChatElements } from '../lib/chat-element-utils'
import { syncWithPostStream, latestPostFor, latestPostIsMine, teardownPresence, setupLastReadMarker, applyPostStream } from '../lib/chat-topic-utils'
import { forEachTopicContainer } from '../lib/chat-topic-iterators'
import { rerender } from '../lib/chat-component-utils'
import { setupLiveUpdate, teardownLiveUpdate, messageBus } from '../lib/chat-live-update-utils'
import BabbleRegistry from '../lib/babble-registry'
import showModal from 'discourse/lib/show-modal'

export default Ember.Object.create({

  disabled() {
    return _.contains(Discourse.Site.current().disabled_plugins, 'babble')
  },

  bindById(component, topicId) {
    return this.loadTopic(topicId).then((topic) => {
      return this.bind(component, topic)
    }, console.log)
  },

  bind(component, topic, postNumber) {
    if (!topic) { return }

    postNumber = postNumber || topic.last_read_post_number

    this.unbind(component)
    topic = BabbleRegistry.bind(component, topic)
    setupLastReadMarker(topic)

    Ember.run.scheduleOnce('afterRender', () => {
      setupLiveUpdate(topic, {
        '':       ((data) => { this.buildTopic(data) }),
        'typing': ((data) => { this.handleTyping(topic, data) }),
        'online': ((data) => { this.handleOnline(topic, data) })
      })

      if (hasChatElements(component.element)) {
        setupScrollContainer(topic)
        setupComposer(topic)
        scrollToPost(topic, postNumber, 0)
      }
    })

    rerender(topic)
    return topic
  },

  unbind(component) {
    let topic = BabbleRegistry.topicForComponent(component)
    if (!topic) { return }

    teardownLiveUpdate(topic, '', 'typing', 'online')

    if (hasChatElements(component.element)) {
      teardownPresence(topic)
    }

    BabbleRegistry.unbind(component)
  },

  loadTopic(id, opts = {}) {
    this.set('loadingTopicId', id)
    let path  = opts.pm ? '/pm' : ''
    let query = opts.postNumber ? `?near_post=${opts.postNumber}` : ''
    return ajax(`/babble/topics/${path}/${id}.json${query}`).then((data) => {
      return this.buildTopic(data)
    }).finally(() => {
      this.set('loadingTopicId', null)
    })
  },

  subscribeToNotifications(component) {
    messageBus().subscribe(`/babble/notifications/${Discourse.User.current().id}`, (data) => {
      BabbleRegistry.storeNotification(data)
      if (!component.initialized) {
        component.set('summary.notificationCount', component.get('summary.notificationCount') + 1)
      }
      component.rerenderWidget()
    })
  },

  loadBoot(component) {
    this.set('loadingBoot', true)
    return ajax(`/babble/boot.json`).then((data) => {
      _.each(data.notifications, (n) => { BabbleRegistry.storeNotification(n) })
      _.each(data.users,         (u) => { BabbleRegistry.storeUser(User.create(u)) })
      _.each(data.topics,        (t) => { this.setupTopicListener(t, component) })
    }).finally(() => {
      component.rerenderWidget()
      this.set('loadingBoot', false)
    })
  },

  loadSummary() {
    this.set('loadingSummary', true)
    return ajax(`/babble/summary.json`).finally(() => {
      this.set('loadingSummary', null)
    })
  },

  setupTopicListener(t, component) {
    setupLiveUpdate(this.buildTopic(t), {
      'posts': (data) => {
        this.handleNewPost(data)
        component.rerenderWidget()
      }
    })
  },

  availableTopics() {
    return BabbleRegistry.allTopics()
  },

  availableUsers() {
    return BabbleRegistry.allUsers()
  },

  availableNotifications() {
    return BabbleRegistry.allNotifications()
  },

  notificationsFor(item) {
    return this.availableNotifications().filter((n) => {
      if (item.constructor == User) {
        return n.sender_id == item.id
      } else {
        return n.topic_id == item.id
      }
    })
  },

  fetchTopic(topicId) {
    return BabbleRegistry.fetchTopic(topicId)
  },

  topicForComponent(component) {
    return BabbleRegistry.topicForComponent(component)
  },

  buildTopic(data) {
    if (!data.id) { return }
    let topic = Topic.create(data)
    applyPostStream(topic)
    syncWithPostStream(topic)
    return BabbleRegistry.storeTopic(topic)
  },

  createPost(topic, text) {
    this.stagePost(topic, text)
    return ajax(`/babble/topics/${topic.id}/posts`, {
      type: 'POST',
      data: { raw: text }
    }).then((data) => {
      this.handleNewPost(data)
    })
  },

  readPost(topic, postNumber) {
    this.notificationsFor(topic).map((n) => {
      if (n.post_number <= postNumber) { BabbleRegistry.removeNotification(n.id) }
    })
    return ajax(`/babble/topics/${topic.id}/read/${postNumber}.json`)
  },

  editPost(topic, post) {
    if (post) {
      topic.set('editingPostId', post.id)
      scrollToPost(topic, post.post_number)
      setupComposer(topic)
    } else {
      topic.set('editingPostId', null)
    }
  },

  flagPost(topic, post) {
    if (post.get('actions_summary')) {
      showModal('flag', { model: post, babble: true })
    } else {
      // we have to get some more info from the API before we can properly display the flag modal
      ajax(`/posts/${post.id}`).then((data) => {
        data = Post.munge(data)
        post.set('actionByName', data.actionByName)
        post.set('actions_summary', data.actions_summary)
        showModal('flag', { model: post, babble: true })
      })
    }
  },

  updatePost(topic, post, text) {
    this.editPost(topic, null)
    topic.set('loadingEditId', post.id)
    return ajax(`/babble/topics/${post.topic_id}/posts/${post.id}`, {
      type: 'POST',
      data: { raw: text }
    }).then((data) => {
      this.handleNewPost(data)
    }).finally(() => {
      topic.set('loadingEditId', null)
    })
  },

  destroyPost(topic, post) {
    topic.set('loadingEditId', post.id)
    return ajax(`/babble/topics/${post.topic_id}/posts/${post.id}`, {
      type: 'DELETE'
    }).finally(() => {
      topic.set('loadingEditId', null)
    })
  },

  populatePermissions(data) {
    const user = Discourse.User.current()

    if (!user || data.user_id != user.id) {
      delete data.can_edit
      delete data.can_flag
      delete data.can_delete
    }

    if(!_.contains(_.keys(data), 'can_edit')) {
      data.can_edit = user.staff ||
                      data.user_id == user.id ||
                      user.trust_level >= 4
    }
    if(!_.contains(_.keys(data), 'can_flag')) {
      data.can_flag = !data.user_id != user.id &&
                      (user.staff || user.trust_level >= 1)
    }
    if(!_.contains(_.keys(data), 'can_delete')) {
      data.can_delete = user.staff || data.user_id == user.id
    }

    return data
  },

  handleNewPost(data) {
    let topic = BabbleRegistry.fetchTopic(data.topic_id)
    if (!topic) { return }

    delete topic.typing[data.username]

    let post = Post.create(this.populatePermissions(data))
    if (post.created_at.match(/UTC/)) {
      post.created_at = moment(post.created_at.replace(' UTC', 'Z')).local().toString()
    }

    if (data.is_edit || data.is_delete) {
      topic.postStream.storePost(post)
    } else {

      let performScroll = _.any(forEachTopicContainer(topic, function($container) {
        return lastVisibleElement($container.find('.babble-chat'), '.babble-post', 'post-number') == topic.lastLoadedPostNumber
      }))

      if (topic.lastLoadedPostNumber < post.post_number) {
        topic.set('lastLoadedPostNumber', post.post_number)
      }

      if (latestPostIsMine(topic)) {
        // clear staged post
        let staged =  topic.postStream.findLoadedPost(-1)
        if (staged) { topic.postStream.removePosts([staged]) }
        topic.postStream.commitPost(post)
      } else {
        if (performScroll) { topic.set('last_read_post_number', post.post_number) }
        topic.postStream.appendPost(post)
      }

      if (performScroll) { scrollToPost(topic, post.post_number) }
    }

    return syncWithPostStream(topic)
  },

  handleTyping(topic, data) {
    if (Discourse.User.current() && data.id == Discourse.User.current().id) { return }
    topic.typing[data.username] = { user: data, lastTyped: moment() }
    rerender(topic)
  },

  handleOnline(topic, data) {
    if (Discourse.User.current() && data.id == Discourse.User.current().id) { return }
    topic.online[data.username] = { user: data, lastSeen: moment() }
    rerender(topic)
  },

  loadPosts(topic, order) {
    topic.set('loadingPosts', order)
    rerender(topic)
    let starterPostField = order === 'desc' ? 'firstLoadedPostNumber' : 'lastLoadedPostNumber'
    let postNumber = topic.get(starterPostField)

    return ajax(`/babble/topics/${topic.id}/posts/${postNumber}/${order}`).then((data) => {
      data.posts.map(function(post) { topic.postStream.appendPost(Post.create(post)) })
      syncWithPostStream(topic)
      scrollToPost(topic, topic.get(starterPostField))
    }).finally(() => {
      topic.set('loadingPosts', null)
    })
  },

  stagePost(topic, text) {
    const user = Discourse.User.current()

    let post = Post.create({
      raw:                text,
      cooked:             text,
      name:               user.get('name'),
      display_username:   user.get('name'),
      username:           user.get('username'),
      user_id:            user.get('id'),
      user_title:         user.get('title'),
      avatar_template:    user.get('avatar_template'),
      user_custom_fields: user.get('custom_fields'),
      moderator:          user.get('moderator'),
      admin:              user.get('admin'),
      created_at:         moment()
    })
    topic.postStream.stagePost(post, user)
    topic.set('lastLoadedPostNumber', post.post_number)
    scrollToPost(topic, post.post_number)
    teardownComposer(topic)
    rerender(topic)
  }
})
